import { Router, type IRouter } from "express";
import {
  db,
  locationAllowedDestinationsTable,
  locationsTable,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/location-allowed-destinations", async (_req, res) => {
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
});

export default router;
