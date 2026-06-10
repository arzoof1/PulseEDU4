import { Storage } from "@google-cloud/storage";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  StoredObjectRef,
  canAccessObject,
  getObjectAclPolicy,
  getS3Client,
  headStoredObject,
  openStoredObjectWebStream,
  readStoredObjectBuffer,
  s3BucketName,
  s3PrivatePrefix,
  s3PublicPrefix,
  setObjectAclPolicy,
  storedObjectExists,
  useS3ObjectStorage,
} from "./storedObject.js";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  getPublicObjectSearchPaths(): Array<string> {
    if (useS3ObjectStorage()) {
      return [`/${s3BucketName()}/${s3PublicPrefix()}`];
    }

    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. For AWS, set S3_BUCKET + AWS credentials. " +
          "For Replit/GCS, set PUBLIC_OBJECT_SEARCH_PATHS (comma-separated paths).",
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    if (useS3ObjectStorage()) {
      return `/${s3BucketName()}/${s3PrivatePrefix()}`;
    }

    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. For AWS, set S3_BUCKET + AWS credentials. " +
          "For Replit/GCS, set PRIVATE_OBJECT_DIR.",
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<StoredObjectRef | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;
      const { bucketName, objectName } = parseObjectPath(fullPath);

      if (useS3ObjectStorage()) {
        const ref: StoredObjectRef = {
          provider: "s3",
          bucket: bucketName,
          key: objectName,
        };
        if (await storedObjectExists(ref)) return ref;
        continue;
      }

      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        return { provider: "gcs", file };
      }
    }

    return null;
  }

  async downloadObject(
    objectRef: StoredObjectRef,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const aclPolicy = await getObjectAclPolicy(objectRef);
    const isPublic = aclPolicy?.visibility === "public";
    const { contentType, contentLength } = await headStoredObject(objectRef);
    const webStream = await openStoredObjectWebStream(objectRef);

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (contentLength != null) {
      headers["Content-Length"] = String(contentLength);
    }

    return new Response(webStream, { headers });
  }

  async readObjectAsBuffer(objectPath: string): Promise<Buffer | null> {
    try {
      const ref = await this.getObjectEntityFile(objectPath);
      return await readStoredObjectBuffer(ref);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return null;
      return null;
    }
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);

    if (useS3ObjectStorage()) {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: objectName,
      });
      return getSignedUrl(getS3Client(), command, { expiresIn: 900 });
    }

    return signReplitObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<StoredObjectRef> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);

    if (useS3ObjectStorage()) {
      const ref: StoredObjectRef = {
        provider: "s3",
        bucket: bucketName,
        key: objectName,
      };
      if (!(await storedObjectExists(ref))) {
        throw new ObjectNotFoundError();
      }
      return ref;
    }

    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return { provider: "gcs", file: objectFile };
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.startsWith("/objects/")) {
      return rawPath;
    }

    if (rawPath.startsWith("https://storage.googleapis.com/")) {
      const url = new URL(rawPath);
      const rawObjectPath = url.pathname;
      let objectEntityDir = this.getPrivateObjectDir();
      if (!objectEntityDir.endsWith("/")) {
        objectEntityDir = `${objectEntityDir}/`;
      }
      if (!rawObjectPath.startsWith(objectEntityDir)) {
        return rawObjectPath;
      }
      const entityId = rawObjectPath.slice(objectEntityDir.length);
      return `/objects/${entityId}`;
    }

    if (
      useS3ObjectStorage() &&
      rawPath.startsWith("https://") &&
      (rawPath.includes(".amazonaws.com/") || rawPath.includes("s3."))
    ) {
      const url = new URL(rawPath);
      const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const prefix = `${s3PrivatePrefix()}/`;
      if (key.startsWith(prefix)) {
        return `/objects/${key.slice(prefix.length)}`;
      }
      const bucket = s3BucketName();
      const bucketPrefix = `${bucket}/`;
      if (key.startsWith(bucketPrefix)) {
        const withoutBucket = key.slice(bucketPrefix.length);
        if (withoutBucket.startsWith(prefix)) {
          return `/objects/${withoutBucket.slice(prefix.length)}`;
        }
      }
    }

    return rawPath;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectRef = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectRef, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectRef,
    requestedPermission,
  }: {
    userId?: string;
    objectRef: StoredObjectRef;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectRef,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1]!;
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signReplitObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`,
    );
  }

  const { signed_url: signedURL } = (await response.json()) as {
    signed_url: string;
  };
  return signedURL;
}
