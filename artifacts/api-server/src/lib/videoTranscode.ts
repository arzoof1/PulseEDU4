// PulseDNA video transcode pipeline.
//
// The Recording Studio uploads a single accepted take as WebM (VP8/VP9 + Opus,
// whatever the browser's MediaRecorder produced). Browsers can play that back,
// but it is a poor attachment for families: iOS Safari and many email/SMS
// preview surfaces can't play WebM, and there's no audio-only option. So the
// server derives two broadly-playable artifacts:
//   - MP4  (H.264 + AAC, +faststart) — plays everywhere, streams progressively.
//   - MP3  (libmp3lame)              — audio-only, for low-bandwidth / phone use.
//
// Runs fire-and-forget after the upload row is created (the route returns 202
// immediately and the client polls for status). ffmpeg is invoked via spawn;
// the binary is on PATH in this environment (nix). On any failure the row flips
// to status="failed" with an errorReason so the client can show a retry.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, pulseDnaVideosTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage.js";
import {
  issueSchoolUploadUrl,
  bindObjectToSchool,
} from "../routes/storage.js";
import { logger } from "./logger.js";

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const objectStorageService = new ObjectStorageService();

// Run ffmpeg with the given args; resolve on exit 0, reject with the tail of
// stderr otherwise. stdout/stderr are drained so the process never blocks on a
// full pipe buffer for a long encode.
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep only the tail — ffmpeg is very chatty and we just want the error.
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
}

// Upload a local file to object storage, bound to the school, and return its
// /objects/... key. Mirrors the client upload dance (request URL → PUT) but
// server-side, using the higher-capacity issueSchoolUploadUrl helper.
async function uploadDerived(
  localPath: string,
  contentType: string,
  schoolId: number,
): Promise<string> {
  const { uploadURL, objectPath } = await issueSchoolUploadUrl(schoolId);
  const bytes = await readFile(localPath);
  const put = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`derived upload failed (${put.status})`);
  }
  const bound = await bindObjectToSchool(objectPath, schoolId);
  if (!bound) {
    throw new Error("derived upload could not be bound to school");
  }
  return objectPath;
}

async function fileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return 0;
  }
}

// Transcode a single video row. Idempotent enough to be called again on a
// stuck row: it re-downloads the original and re-derives. Only touches rows
// that still have an original and are not already purged.
export async function transcodePulseDnaVideo(
  videoId: number,
  schoolId: number,
): Promise<void> {
  const [row] = await db
    .select()
    .from(pulseDnaVideosTable)
    .where(
      and(
        eq(pulseDnaVideosTable.id, videoId),
        eq(pulseDnaVideosTable.schoolId, schoolId),
      ),
    );
  if (!row) {
    logger.warn({ videoId, schoolId }, "[pulseDnaVideo] transcode: row missing");
    return;
  }
  if (row.status === "purged") return;
  if (!row.originalObjectKey) {
    await markFailed(videoId, schoolId, "No uploaded source to transcode");
    return;
  }

  let workDir: string | null = null;
  try {
    const file = await objectStorageService.getObjectEntityFile(
      row.originalObjectKey,
    );
    workDir = await mkdtemp(join(tmpdir(), "pulsedna-"));
    const inPath = join(workDir, "input.webm");
    const mp4Path = join(workDir, "output.mp4");
    const mp3Path = join(workDir, "output.mp3");

    await file.download({ destination: inPath });

    // MP4: H.264 baseline-friendly + AAC, faststart so the moov atom is at the
    // front and the file streams before it's fully downloaded.
    await runFfmpeg([
      "-y",
      "-i",
      inPath,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      mp4Path,
    ]);

    // MP3: audio only.
    await runFfmpeg([
      "-y",
      "-i",
      inPath,
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      mp3Path,
    ]);

    const mp4Key = await uploadDerived(mp4Path, "video/mp4", schoolId);
    const audioKey = await uploadDerived(mp3Path, "audio/mpeg", schoolId);

    const origSize = row.sizeBytes ?? 0;
    const derivedSize = (await fileSize(mp4Path)) + (await fileSize(mp3Path));

    await db
      .update(pulseDnaVideosTable)
      .set({
        status: "ready",
        mp4ObjectKey: mp4Key,
        audioObjectKey: audioKey,
        sizeBytes: origSize + derivedSize,
        errorReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pulseDnaVideosTable.id, videoId),
          eq(pulseDnaVideosTable.schoolId, schoolId),
        ),
      );

    logger.info({ videoId, schoolId }, "[pulseDnaVideo] transcode complete");
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown transcode error";
    logger.error(
      { videoId, schoolId, err: message },
      "[pulseDnaVideo] transcode failed",
    );
    await markFailed(videoId, schoolId, message.slice(0, 500));
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function markFailed(
  videoId: number,
  schoolId: number,
  reason: string,
): Promise<void> {
  await db
    .update(pulseDnaVideosTable)
    .set({ status: "failed", errorReason: reason, updatedAt: new Date() })
    .where(
      and(
        eq(pulseDnaVideosTable.id, videoId),
        eq(pulseDnaVideosTable.schoolId, schoolId),
      ),
    );
}

// Recover rows that were left "processing" by a crash/restart mid-encode.
// Called once on boot. Anything still processing after a generous grace window
// is re-kicked (fire-and-forget). We don't block boot on the encodes.
export async function recoverStuckPulseDnaVideos(): Promise<void> {
  const stuck = await db
    .select({
      id: pulseDnaVideosTable.id,
      schoolId: pulseDnaVideosTable.schoolId,
    })
    .from(pulseDnaVideosTable)
    .where(
      and(
        eq(pulseDnaVideosTable.status, "processing"),
        sql`${pulseDnaVideosTable.createdAt} < NOW() - INTERVAL '10 minutes'`,
      ),
    );
  for (const row of stuck) {
    logger.info(
      { videoId: row.id, schoolId: row.schoolId },
      "[pulseDnaVideo] re-kicking stuck transcode",
    );
    void transcodePulseDnaVideo(row.id, row.schoolId);
  }
}
