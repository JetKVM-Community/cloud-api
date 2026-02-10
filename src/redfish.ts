import { Router, type Request, type Response } from "express";
import * as jose from "jose";
import { prisma } from "./db";
import { activeConnections } from "./webrtc-signaling";
import { NotFoundError, BadRequestError } from "./errors";
import { getResetKeySequence } from "./redfish-keys";

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
} as const;

// ---------------------------------------------------------------------------
// Authentication middleware for Redfish
// Supports both session-based (OIDC cookie) and HTTP Basic Auth
// ---------------------------------------------------------------------------
export async function redfishAuthenticated(
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
) {
  // Try session-based auth first (existing OIDC cookie)
  const idToken = req.session?.id_token;
  if (idToken) {
    try {
      const { sub } = jose.decodeJwt(idToken);
      if (sub) {
        (req as any).redfishSub = sub;
        return next();
      }
    } catch {
      // Fall through to Basic Auth
    }
  }

  // Try HTTP Basic Auth (for machine-to-machine / Redfish clients)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const [username, password] = decoded.split(":");

    if (username && password) {
      // Look up the device by its secret token (password) and device id (username)
      const device = await prisma.device.findFirst({
        where: { id: username, secretToken: password },
        include: { user: true },
      });

      if (device?.user) {
        (req as any).redfishSub = device.user.googleId;
        return next();
      }
    }

    return res.status(401).json(redfishError("Base.1.0.NoValidSession", "Invalid credentials."));
  }

  return res
    .status(401)
    .set("WWW-Authenticate", 'Basic realm="JetKVM Redfish Service"')
    .json(redfishError("Base.1.0.NoValidSession", "Authentication required."));
}

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
async function getUserDevices(sub: string) {
  return prisma.device.findMany({
    where: { user: { googleId: sub } },
    select: { id: true, name: true, lastSeen: true },
  });
}

async function getUserDevice(sub: string, deviceId: string) {
  return prisma.device.findUnique({
    where: { id: deviceId, user: { googleId: sub } },
    select: { id: true, name: true, lastSeen: true },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export const redfishRouter = Router();

// All Redfish responses are JSON and include OData-Version header
redfishRouter.use((_req, res, next) => {
  res.set("OData-Version", "4.0");
  next();
});

// -- Service Root (public, per Redfish spec) --------------------------------
redfishRouter.get("/v1", (_req: Request, res: Response) => {
  return res.json({
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

redfishRouter.get("/v1/", (_req: Request, res: Response) => {
  return res.redirect(301, "/redfish/v1");
});

// -- Session Service (public metadata, per spec) ----------------------------
redfishRouter.get("/v1/SessionService", (_req: Request, res: Response) => {
  return res.json({
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
  (_req: Request, res: Response) => {
    return res.json({
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
  async (req: Request, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const devices = await getUserDevices(sub);

    return res.json({
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
  async (req: Request<{ id: string }>, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const { id } = req.params;
    const device = await getUserDevice(sub, id);
    if (!device) throw new NotFoundError("System not found");

    const isOnline = activeConnections.has(device.id);
    const conn = activeConnections.get(device.id);
    const version = conn?.[2] || null;

    return res.json({
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

// -- System Reset Action (sends keyboard combos via WebSocket) ---------------
redfishRouter.post(
  "/v1/Systems/:id/Actions/ComputerSystem.Reset",
  redfishAuthenticated,
  async (req: Request<{ id: string }>, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const { id } = req.params;
    const device = await getUserDevice(sub, id);
    if (!device) throw new NotFoundError("System not found");

    const { ResetType } = req.body as { ResetType?: string };
    if (!ResetType) throw new BadRequestError("ResetType is required");

    const keySequence = getResetKeySequence(ResetType);
    if (!keySequence) {
      throw new BadRequestError(`Unsupported ResetType: ${ResetType}`);
    }

    const conn = activeConnections.get(device.id);
    if (!conn) {
      throw new NotFoundError("Device is not connected");
    }

    const [ws] = conn;

    // Send keyboard commands via the device WebSocket
    for (const combo of keySequence) {
      ws.send(
        JSON.stringify({
          type: "keyboard",
          data: { modifier: combo.modifier, keys: combo.keys },
        }),
      );
    }

    return res.status(204).send();
  },
);

// -- Managers Collection ----------------------------------------------------
redfishRouter.get(
  "/v1/Managers",
  redfishAuthenticated,
  async (req: Request, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const devices = await getUserDevices(sub);

    return res.json({
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
  async (req: Request<{ id: string }>, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const { id } = req.params;
    const device = await getUserDevice(sub, id);
    if (!device) throw new NotFoundError("Manager not found");

    const isOnline = activeConnections.has(device.id);
    const conn = activeConnections.get(device.id);
    const version = conn?.[2] || null;

    return res.json({
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
  async (req: Request<{ id: string }>, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const { id } = req.params;
    const device = await getUserDevice(sub, id);
    if (!device) throw new NotFoundError("Manager not found");

    return res.json({
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
  async (req: Request<{ id: string; mediaId: string }>, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const { id, mediaId } = req.params;
    const device = await getUserDevice(sub, id);
    if (!device) throw new NotFoundError("Manager not found");

    if (mediaId !== "Disc1") throw new NotFoundError("VirtualMedia not found");

    return res.json({
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
  async (req: Request<{ id: string; mediaId: string }>, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const { id, mediaId } = req.params;
    const device = await getUserDevice(sub, id);
    if (!device) throw new NotFoundError("Manager not found");

    if (mediaId !== "Disc1")
      throw new NotFoundError("VirtualMedia not found");

    const { Image } = req.body as { Image?: string };
    if (!Image) throw new BadRequestError("Image URL is required");

    const conn = activeConnections.get(device.id);
    if (!conn) throw new NotFoundError("Device is not connected");

    const [ws] = conn;
    ws.send(
      JSON.stringify({
        type: "virtual-media",
        data: { action: "insert", url: Image },
      }),
    );

    return res.status(204).send();
  },
);

// -- Eject Virtual Media ----------------------------------------------------
redfishRouter.post(
  "/v1/Managers/:id/VirtualMedia/:mediaId/Actions/VirtualMedia.EjectMedia",
  redfishAuthenticated,
  async (req: Request<{ id: string; mediaId: string }>, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const { id, mediaId } = req.params;
    const device = await getUserDevice(sub, id);
    if (!device) throw new NotFoundError("Manager not found");

    if (mediaId !== "Disc1")
      throw new NotFoundError("VirtualMedia not found");

    const conn = activeConnections.get(device.id);
    if (!conn) throw new NotFoundError("Device is not connected");

    const [ws] = conn;
    ws.send(
      JSON.stringify({
        type: "virtual-media",
        data: { action: "eject" },
      }),
    );

    return res.status(204).send();
  },
);

// -- Chassis Collection -----------------------------------------------------
redfishRouter.get(
  "/v1/Chassis",
  redfishAuthenticated,
  async (req: Request, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const devices = await getUserDevices(sub);

    return res.json({
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
  async (req: Request<{ id: string }>, res: Response) => {
    const sub = (req as any).redfishSub as string;
    const { id } = req.params;
    const device = await getUserDevice(sub, id);
    if (!device) throw new NotFoundError("Chassis not found");

    const isOnline = activeConnections.has(device.id);

    return res.json({
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
