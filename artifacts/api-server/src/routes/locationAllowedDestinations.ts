import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  locationAllowedDestinationsTable,
  locationsTable,
  staffTable,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

async function requireSignedIn(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.session.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  next();
}

router.get(
  "/location-allowed-destinations",
  requireSignedIn,
  async (_req, res) => {
    const origin = alias(locationsTable, "origin_loc");
    const dest = alias(locationsTable, "dest_loc");

    const rows = await db
      .select({
        id: locationAllowedDestinationsTable.id,
        originLocationId: locationAllowedDestinationsTable.originLocationId,
        destinationLocationId:
          locationAllowedDestinationsTable.destinationLocationId,
        originName: origin.name,
        destinationName: dest.name,
      })
      .from(locationAllowedDestinationsTable)
      .innerJoin(
        origin,
        eq(origin.id, locationAllowedDestinationsTable.originLocationId),
      )
      .innerJoin(
        dest,
        eq(dest.id, locationAllowedDestinationsTable.destinationLocationId),
      );

    rows.sort((a, b) => {
      const o = a.originName.localeCompare(b.originName);
      if (o !== 0) return o;
      return a.destinationName.localeCompare(b.destinationName);
    });

    res.json(rows);
  },
);

export default router;
