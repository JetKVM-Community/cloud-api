import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import * as jose from "jose";
import type { AppType } from "./env";
import { NotFoundError, BadRequestError } from "./errors";
import { getResetKeySequence } from "./redfish-keys";
import { sendJsonRpc } from "./jsonrpc";

// Redfish protocol version
const REDFISH_VERSION = "1.0.0";

// OData type constants
const ODATA = {
  SERVICE_ROOT: "#ServiceRoot.v1_0_0.ServiceRoot",
  SYSTEMS_COLLECTION: "#ComputerSystemCollection.ComputerSystemCollection",
  COMPUTER_SYSTEM: "#ComputerSystem.v1_0_0.ComputerSystem",
  MANAGERS_COLLECTION: "#ManagerCollection.ManagerCollection",
  MANAGER: "#Manager.v1_0_0.Manager",
  VIRTUAL_MEDIA_COLLECTION: "#VirtualMediaCollection.VirtualMediaCollection",
  VIRTUAL_MEDIA: "#VirtualMedia.v1_0_0.VirtualMedia",
  CHASSIS_COLLECTION: "#ChassisCollection.ChassisCollection",
  CHASSIS: "#Chassis.v1_0_0.Chassis",
  SESSION_SERVICE: "#SessionService.v1_0_0.SessionService",
  SESSION_COLLECTION: "#SessionCollection.SessionCollection",
  JETKVM_EXTENSIONS: "#JetKVMExtensions.v1_0_0.JetKVMExtensions",
  JETKVM_ACTIVE_EXTENSION: "#JetKVMActiveExtension.v1_0_0.JetKVMActiveExtension",
  JETKVM_DC_POWER: "#JetKVMDCPower.v1_0_0.JetKVMDCPower",
  JETKVM_ATX_POWER: "#JetKVMATXPower.v1_0_0.JetKVMATXPower",
} as const;

// ---------------------------------------------------------------------------
// Authentication middleware for Redfish
// Supports both session-based (OIDC cookie) and HTTP Basic Auth
// ---------------------------------------------------------------------------
export const redfishAuthenticated: MiddlewareHandler<AppType> = async (c, next) => {
  // Try session-based auth first (existing OIDC cookie)
  const session = c.get("session");
  const idToken = session?.id_token;
  if (idToken) {
    try {
      const { sub } = jose.decodeJwt(idToken);
      if (sub) {
        c.set("redfishSub" as any, sub);
        return next();
      }
    } catch {
      // Fall through to Basic Auth
    }
  }

  // Try HTTP Basic Auth (for machine-to-machine / Redfish clients)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Basic ")) {
    const decoded = atob(authHeader.slice(6));
    const [username, password] = decoded.split(":");

    if (username && password) {
      const prisma = c.get("prisma");
      // Look up the device by its secret token (password) and device id (username)
      const device = await prisma.device.findFirst({
        where: { id: username, secretToken: password },
        include: { user: true },
      });

      if (device?.user) {
        c.set("redfishSub" as any, device.user.oidcId);
        return next();
      }
    }

    return c.json(
      redfishError("Base.1.0.NoValidSession", "Invalid credentials."),
      401,
    );
  }

  return c.json(
    redfishError("Base.1.0.NoValidSession", "Authentication required."),
    401,
    { "WWW-Authenticate": 'Basic realm="JetKVM Redfish Service"' },
  );
};

// ---------------------------------------------------------------------------
// Redfish error response helper
// ---------------------------------------------------------------------------
function redfishError(code: string, message: string) {
  return {
    error: {
      code: "Base.1.0.GeneralError",
      message: "A general error has occurred.",
      "@Message.ExtendedInfo": [
        {
          "@odata.type": "#Message.v1_0_0.Message",
          MessageId: code,
          Message: message,
          Severity: "Warning",
          Resolution: "See Redfish specification.",
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: get user devices
// ---------------------------------------------------------------------------
async function getUserDevices(c: Context<AppType>) {
  const sub = c.get("redfishSub" as any) as string;
  const prisma = c.get("prisma");
  return prisma.device.findMany({
    where: { user: { oidcId: sub } },
    select: { id: true, name: true, lastSeen: true },
  });
}

async function getUserDevice(c: Context<AppType>, deviceId: string) {
  const sub = c.get("redfishSub" as any) as string;
  const prisma = c.get("prisma");
  return prisma.device.findUnique({
    where: { id: deviceId, user: { oidcId: sub } },
    select: { id: true, name: true, lastSeen: true },
  });
}

/**
 * Helper to get device status (online/version) from its Durable Object.
 */
async function getDeviceStatus(
  c: Context<AppType>,
  deviceId: string,
): Promise<{ online: boolean; version: string | null }> {
  const doId = c.env.DEVICE_SIGNALING.idFromName(deviceId);
  const stub = c.env.DEVICE_SIGNALING.get(doId);
  const resp = await stub.fetch(new Request("https://do/status"));
  return resp.json() as Promise<{ online: boolean; version: string | null }>;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export const redfishRouter = new Hono<AppType>();

// All Redfish responses include OData-Version header
redfishRouter.use("*", async (c, next) => {
  await next();
  c.header("OData-Version", "4.0");
});

// -- Service Root (public, per Redfish spec) --------------------------------
redfishRouter.get("/v1", (c) => {
  return c.json({
    "@odata.type": ODATA.SERVICE_ROOT,
    "@odata.id": "/redfish/v1",
    Id: "RootService",
    Name: "JetKVM Redfish Service",
    RedfishVersion: REDFISH_VERSION,
    Systems: { "@odata.id": "/redfish/v1/Systems" },
    Managers: { "@odata.id": "/redfish/v1/Managers" },
    Chassis: { "@odata.id": "/redfish/v1/Chassis" },
    SessionService: { "@odata.id": "/redfish/v1/SessionService" },
  });
});

redfishRouter.get("/v1/", (c) => {
  return c.redirect("/redfish/v1", 301);
});

// -- Session Service (public metadata, per spec) ----------------------------
redfishRouter.get("/v1/SessionService", (c) => {
  return c.json({
    "@odata.type": ODATA.SESSION_SERVICE,
    "@odata.id": "/redfish/v1/SessionService",
    Id: "SessionService",
    Name: "Session Service",
    Description: "JetKVM Session Service – sessions are managed via OIDC or Basic Auth",
    Status: { State: "Enabled", Health: "OK" },
    Sessions: { "@odata.id": "/redfish/v1/SessionService/Sessions" },
  });
});

redfishRouter.get(
  "/v1/SessionService/Sessions",
  redfishAuthenticated,
  (c) => {
    return c.json({
      "@odata.type": ODATA.SESSION_COLLECTION,
      "@odata.id": "/redfish/v1/SessionService/Sessions",
      Name: "Session Collection",
      Members: [],
      "Members@odata.count": 0,
    });
  },
);

// -- Systems Collection -----------------------------------------------------
redfishRouter.get(
  "/v1/Systems",
  redfishAuthenticated,
  async (c) => {
    const devices = await getUserDevices(c);

    return c.json({
      "@odata.type": ODATA.SYSTEMS_COLLECTION,
      "@odata.id": "/redfish/v1/Systems",
      Name: "Computer System Collection",
      "Members@odata.count": devices.length,
      Members: devices.map((d) => ({ "@odata.id": `/redfish/v1/Systems/${d.id}` })),
    });
  },
);

// -- Individual System ------------------------------------------------------
redfishRouter.get(
  "/v1/Systems/:id",
  redfishAuthenticated,
  async (c) => {
    const id = c.req.param("id");
    const device = await getUserDevice(c, id);
    if (!device) throw new NotFoundError("System not found");

    let isOnline = false;
    let version: string | null = null;
    try {
      const status = await getDeviceStatus(c, device.id);
      isOnline = status.online;
      version = status.version;
    } catch {
      // Device might not have a DO instance yet
    }

    return c.json({
      "@odata.type": ODATA.COMPUTER_SYSTEM,
      "@odata.id": `/redfish/v1/Systems/${device.id}`,
      Id: device.id,
      Name: device.name,
      SystemType: "Physical",
      Manufacturer: "JetKVM",
      Status: {
        State: isOnline ? "Enabled" : "StandbyOffline",
        Health: isOnline ? "OK" : "Warning",
      },
      PowerState: isOnline ? "On" : "Off",
      FirmwareVersion: version,
      LastSeen: device.lastSeen?.toISOString() ?? null,
      Actions: {
        "#ComputerSystem.Reset": {
          target: `/redfish/v1/Systems/${device.id}/Actions/ComputerSystem.Reset`,
          "ResetType@Redfish.AllowableValues": [
            "On",
            "ForceOff",
            "GracefulShutdown",
            "GracefulRestart",
            "ForceRestart",
          ],
        },
      },
      Links: {
        Chassis: [{ "@odata.id": `/redfish/v1/Chassis/${device.id}` }],
        ManagedBy: [{ "@odata.id": `/redfish/v1/Managers/${device.id}` }],
      },
    });
  },
);

// -- System Reset Action (sends keyboard combos via Durable Object) ----------
redfishRouter.post(
  "/v1/Systems/:id/Actions/ComputerSystem.Reset",
  redfishAuthenticated,
  async (c) => {
    const id = c.req.param("id");
    const device = await getUserDevice(c, id);
    if (!device) throw new NotFoundError("System not found");

    const body = await c.req.json();
    const { ResetType } = body as { ResetType?: string };
    if (!ResetType) throw new BadRequestError("ResetType is required");

    const keySequence = getResetKeySequence(ResetType);
    if (!keySequence) {
      throw new BadRequestError(`Unsupported ResetType: ${ResetType}`);
    }

    // Send keyboard commands via the device's Durable Object
    for (const combo of keySequence) {
      const doId = c.env.DEVICE_SIGNALING.idFromName(device.id);
      const stub = c.env.DEVICE_SIGNALING.get(doId);
      await stub.fetch(new Request("https://do/command", {
        method: "POST",
        body: JSON.stringify({
          type: "keyboard",
          data: { modifier: combo.modifier, keys: combo.keys },
        }),
      }));
    }

    return c.body(null, 204);
  },
);

// -- Managers Collection ----------------------------------------------------
redfishRouter.get(
  "/v1/Managers",
  redfishAuthenticated,
  async (c) => {
    const devices = await getUserDevices(c);

    return c.json({
      "@odata.type": ODATA.MANAGERS_COLLECTION,
      "@odata.id": "/redfish/v1/Managers",
      Name: "Manager Collection",
      "Members@odata.count": devices.length,
      Members: devices.map((d) => ({ "@odata.id": `/redfish/v1/Managers/${d.id}` })),
    });
  },
);

// -- Individual Manager -----------------------------------------------------
redfishRouter.get(
  "/v1/Managers/:id",
  redfishAuthenticated,
  async (c) => {
    const id = c.req.param("id");
    const device = await getUserDevice(c, id);
    if (!device) throw new NotFoundError("Manager not found");

    let isOnline = false;
    let version: string | null = null;
    try {
      const status = await getDeviceStatus(c, device.id);
      isOnline = status.online;
      version = status.version;
    } catch {
      // Device might not have a DO instance yet
    }

    return c.json({
      "@odata.type": ODATA.MANAGER,
      "@odata.id": `/redfish/v1/Managers/${device.id}`,
      Id: device.id,
      Name: `JetKVM Manager – ${device.name}`,
      ManagerType: "BMC",
      FirmwareVersion: version,
      Status: {
        State: isOnline ? "Enabled" : "StandbyOffline",
        Health: isOnline ? "OK" : "Warning",
      },
      VirtualMedia: {
        "@odata.id": `/redfish/v1/Managers/${device.id}/VirtualMedia`,
      },
      Oem: {
        JetKVM: {
          Extensions: {
            "@odata.id": `/redfish/v1/Managers/${device.id}/Oem/JetKVM/Extensions`,
          },
          DCPower: {
            "@odata.id": `/redfish/v1/Managers/${device.id}/Oem/JetKVM/DCPower`,
          },
          ATXPower: {
            "@odata.id": `/redfish/v1/Managers/${device.id}/Oem/JetKVM/ATXPower`,
          },
        },
      },
      Links: {
        ManagerForServers: [
          { "@odata.id": `/redfish/v1/Systems/${device.id}` },
        ],
        ManagerForChassis: [
          { "@odata.id": `/redfish/v1/Chassis/${device.id}` },
        ],
      },
    });
  },
);

// -- Virtual Media Collection -----------------------------------------------
redfishRouter.get(
  "/v1/Managers/:id/VirtualMedia",
  redfishAuthenticated,
  async (c) => {
    const id = c.req.param("id");
    const device = await getUserDevice(c, id);
    if (!device) throw new NotFoundError("Manager not found");

    return c.json({
      "@odata.type": ODATA.VIRTUAL_MEDIA_COLLECTION,
      "@odata.id": `/redfish/v1/Managers/${device.id}/VirtualMedia`,
      Name: "Virtual Media Collection",
      "Members@odata.count": 1,
      Members: [
        {
          "@odata.id": `/redfish/v1/Managers/${device.id}/VirtualMedia/Disc1`,
        },
      ],
    });
  },
);

// -- Virtual Media Instance -------------------------------------------------
redfishRouter.get(
  "/v1/Managers/:id/VirtualMedia/:mediaId",
  redfishAuthenticated,
  async (c) => {
    const id = c.req.param("id");
    const mediaId = c.req.param("mediaId");
    const device = await getUserDevice(c, id);
    if (!device) throw new NotFoundError("Manager not found");

    if (mediaId !== "Disc1") throw new NotFoundError("VirtualMedia not found");

    return c.json({
      "@odata.type": ODATA.VIRTUAL_MEDIA,
      "@odata.id": `/redfish/v1/Managers/${device.id}/VirtualMedia/Disc1`,
      Id: "Disc1",
      Name: "Virtual Disc Drive",
      MediaTypes: ["CD", "DVD", "USBStick"],
      Image: null,
      Inserted: false,
      ConnectedVia: "NotConnected",
      Actions: {
        "#VirtualMedia.InsertMedia": {
          target: `/redfish/v1/Managers/${device.id}/VirtualMedia/Disc1/Actions/VirtualMedia.InsertMedia`,
        },
        "#VirtualMedia.EjectMedia": {
          target: `/redfish/v1/Managers/${device.id}/VirtualMedia/Disc1/Actions/VirtualMedia.EjectMedia`,
        },
      },
    });
  },
);

// -- Insert Virtual Media ---------------------------------------------------
redfishRouter.post(
  "/v1/Managers/:id/VirtualMedia/:mediaId/Actions/VirtualMedia.InsertMedia",
  redfishAuthenticated,
  async (c) => {
    const id = c.req.param("id");
    const mediaId = c.req.param("mediaId");
    const device = await getUserDevice(c, id);
    if (!device) throw new NotFoundError("Manager not found");

    if (mediaId !== "Disc1")
      throw new NotFoundError("VirtualMedia not found");

    const body = await c.req.json();
    const { Image } = body as { Image?: string };
    if (!Image) throw new BadRequestError("Image URL is required");

    const doId = c.env.DEVICE_SIGNALING.idFromName(device.id);
    const stub = c.env.DEVICE_SIGNALING.get(doId);
    const resp = await stub.fetch(new Request("https://do/status"));
    const status = (await resp.json()) as { online: boolean };
    if (!status.online) throw new NotFoundError("Device is not connected");

    await stub.fetch(new Request("https://do/command", {
      method: "POST",
      body: JSON.stringify({
        type: "virtual-media",
        data: { action: "insert", url: Image },
      }),
    }));

    return c.body(null, 204);
  },
);

// -- Eject Virtual Media ----------------------------------------------------
redfishRouter.post(
  "/v1/Managers/:id/VirtualMedia/:mediaId/Actions/VirtualMedia.EjectMedia",
  redfishAuthenticated,
  async (c) => {
    const id = c.req.param("id");
    const mediaId = c.req.param("mediaId");
    const device = await getUserDevice(c, id);
    if (!device) throw new NotFoundError("Manager not found");

    if (mediaId !== "Disc1")
      throw new NotFoundError("VirtualMedia not found");

    const doId = c.env.DEVICE_SIGNALING.idFromName(device.id);
    const stub = c.env.DEVICE_SIGNALING.get(doId);
    const resp = await stub.fetch(new Request("https://do/status"));
    const status = (await resp.json()) as { online: boolean };
    if (!status.online) throw new NotFoundError("Device is not connected");

    await stub.fetch(new Request("https://do/command", {
      method: "POST",
      body: JSON.stringify({
        type: "virtual-media",
        data: { action: "eject" },
      }),
    }));

    return c.body(null, 204);
  },
);

// -- OEM: JetKVM Extensions -------------------------------------------------

// Helper to get a connected device for RPC calls via Durable Object
async function getDeviceForRpc(c: Context<AppType>, deviceId: string) {
  const device = await getUserDevice(c, deviceId);
  if (!device) throw new NotFoundError("Manager not found");

  const status = await getDeviceStatus(c, device.id);
  if (!status.online) throw new NotFoundError("Device is not connected");

  return device;
}

// -- Extensions overview ----------------------------------------------------
redfishRouter.get(
  "/v1/Managers/:id/Oem/JetKVM/Extensions",
  redfishAuthenticated,
  async (c) => {
    const device = await getDeviceForRpc(c, c.req.param("id"));

    const activeExtension = await sendJsonRpc(c.env, device.id, "getActiveExtension", {});

    return c.json({
      "@odata.type": ODATA.JETKVM_EXTENSIONS,
      "@odata.id": `/redfish/v1/Managers/${device.id}/Oem/JetKVM/Extensions`,
      Id: "Extensions",
      Name: "JetKVM Extensions",
      ActiveExtension: activeExtension,
      AvailableExtensions: ["", "atx-power", "dc-power"],
      Active: {
        "@odata.id": `/redfish/v1/Managers/${device.id}/Oem/JetKVM/Extensions/Active`,
      },
      Actions: {
        "#JetKVMExtensions.SetActiveExtension": {
          target: `/redfish/v1/Managers/${device.id}/Oem/JetKVM/Extensions/Actions/SetActiveExtension`,
          "extensionId@Redfish.AllowableValues": ["", "atx-power", "dc-power"],
        },
      },
    });
  },
);

// -- Active Extension details -----------------------------------------------
redfishRouter.get(
  "/v1/Managers/:id/Oem/JetKVM/Extensions/Active",
  redfishAuthenticated,
  async (c) => {
    const device = await getDeviceForRpc(c, c.req.param("id"));

    const activeExtension = await sendJsonRpc(c.env, device.id, "getActiveExtension", {});

    return c.json({
      "@odata.type": ODATA.JETKVM_ACTIVE_EXTENSION,
      "@odata.id": `/redfish/v1/Managers/${device.id}/Oem/JetKVM/Extensions/Active`,
      Id: "Active",
      Name: "Active Extension",
      ExtensionId: activeExtension,
    });
  },
);

// -- Set Active Extension ---------------------------------------------------
redfishRouter.post(
  "/v1/Managers/:id/Oem/JetKVM/Extensions/Actions/SetActiveExtension",
  redfishAuthenticated,
  async (c) => {
    const device = await getDeviceForRpc(c, c.req.param("id"));

    const body = await c.req.json();
    const { extensionId } = body as { extensionId?: string };
    if (extensionId === undefined) throw new BadRequestError("extensionId is required");

    await sendJsonRpc(c.env, device.id, "setActiveExtension", { extensionId });

    return c.body(null, 204);
  },
);

// -- DC Power State ---------------------------------------------------------
redfishRouter.get(
  "/v1/Managers/:id/Oem/JetKVM/DCPower",
  redfishAuthenticated,
  async (c) => {
    const device = await getDeviceForRpc(c, c.req.param("id"));

    const dcState = (await sendJsonRpc(c.env, device.id, "getDCPowerState", {})) as any;

    return c.json({
      "@odata.type": ODATA.JETKVM_DC_POWER,
      "@odata.id": `/redfish/v1/Managers/${device.id}/Oem/JetKVM/DCPower`,
      Id: "DCPower",
      Name: "DC Power Control",
      IsOn: dcState?.isOn ?? false,
      Voltage: dcState?.voltage ?? 0,
      Current: dcState?.current ?? 0,
      Power: dcState?.power ?? 0,
      RestoreState: dcState?.restoreState ?? 0,
      Actions: {
        "#JetKVMDCPower.SetState": {
          target: `/redfish/v1/Managers/${device.id}/Oem/JetKVM/DCPower/Actions/SetState`,
        },
      },
    });
  },
);

// -- Set DC Power State -----------------------------------------------------
redfishRouter.post(
  "/v1/Managers/:id/Oem/JetKVM/DCPower/Actions/SetState",
  redfishAuthenticated,
  async (c) => {
    const device = await getDeviceForRpc(c, c.req.param("id"));

    const body = await c.req.json();
    const { enabled } = body as { enabled?: boolean };
    if (enabled === undefined) throw new BadRequestError("enabled is required");

    await sendJsonRpc(c.env, device.id, "setDCPowerState", { enabled });

    return c.body(null, 204);
  },
);

// -- ATX Power State --------------------------------------------------------
redfishRouter.get(
  "/v1/Managers/:id/Oem/JetKVM/ATXPower",
  redfishAuthenticated,
  async (c) => {
    const device = await getDeviceForRpc(c, c.req.param("id"));

    const atxState = (await sendJsonRpc(c.env, device.id, "getATXState", {})) as any;

    return c.json({
      "@odata.type": ODATA.JETKVM_ATX_POWER,
      "@odata.id": `/redfish/v1/Managers/${device.id}/Oem/JetKVM/ATXPower`,
      Id: "ATXPower",
      Name: "ATX Power Control",
      Power: atxState?.power ?? false,
      HDD: atxState?.hdd ?? false,
      Actions: {
        "#JetKVMATXPower.SetPowerAction": {
          target: `/redfish/v1/Managers/${device.id}/Oem/JetKVM/ATXPower/Actions/SetPowerAction`,
          "action@Redfish.AllowableValues": [
            "power-short",
            "power-long",
            "reset",
          ],
        },
      },
    });
  },
);

// -- Set ATX Power Action ---------------------------------------------------
redfishRouter.post(
  "/v1/Managers/:id/Oem/JetKVM/ATXPower/Actions/SetPowerAction",
  redfishAuthenticated,
  async (c) => {
    const device = await getDeviceForRpc(c, c.req.param("id"));

    const body = await c.req.json();
    const { action } = body as { action?: string };
    if (!action) throw new BadRequestError("action is required");

    const allowed = ["power-short", "power-long", "reset"];
    if (!allowed.includes(action)) {
      throw new BadRequestError(`Unsupported action: ${action}. Allowed: ${allowed.join(", ")}`);
    }

    await sendJsonRpc(c.env, device.id, "setATXPowerAction", { action });

    return c.body(null, 204);
  },
);

// -- Chassis Collection -----------------------------------------------------
redfishRouter.get(
  "/v1/Chassis",
  redfishAuthenticated,
  async (c) => {
    const devices = await getUserDevices(c);

    return c.json({
      "@odata.type": ODATA.CHASSIS_COLLECTION,
      "@odata.id": "/redfish/v1/Chassis",
      Name: "Chassis Collection",
      "Members@odata.count": devices.length,
      Members: devices.map((d) => ({ "@odata.id": `/redfish/v1/Chassis/${d.id}` })),
    });
  },
);

// -- Individual Chassis -----------------------------------------------------
redfishRouter.get(
  "/v1/Chassis/:id",
  redfishAuthenticated,
  async (c) => {
    const id = c.req.param("id");
    const device = await getUserDevice(c, id);
    if (!device) throw new NotFoundError("Chassis not found");

    let isOnline = false;
    try {
      const status = await getDeviceStatus(c, device.id);
      isOnline = status.online;
    } catch {
      // Device might not have a DO instance yet
    }

    return c.json({
      "@odata.type": ODATA.CHASSIS,
      "@odata.id": `/redfish/v1/Chassis/${device.id}`,
      Id: device.id,
      Name: device.name,
      ChassisType: "RackMount",
      Manufacturer: "JetKVM",
      Status: {
        State: isOnline ? "Enabled" : "StandbyOffline",
        Health: isOnline ? "OK" : "Warning",
      },
      Links: {
        ComputerSystems: [
          { "@odata.id": `/redfish/v1/Systems/${device.id}` },
        ],
        ManagedBy: [
          { "@odata.id": `/redfish/v1/Managers/${device.id}` },
        ],
      },
    });
  },
);
