import type { File } from "@google-cloud/storage";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

const GCS_ACL_METADATA_KEY = "custom:aclPolicy";
const S3_ACL_METADATA_KEY = "aclpolicy";

export enum ObjectAccessGroupType {}

export interface ObjectAccessGroup {
  type: ObjectAccessGroupType;
  id: string;
}

export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

export interface ObjectAclRule {
  group: ObjectAccessGroup;
  permission: ObjectPermission;
}

export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
  aclRules?: Array<ObjectAclRule>;
}

export type StoredObjectRef =
  | { provider: "gcs"; file: File }
  | { provider: "s3"; bucket: string; key: string };

let s3Client: S3Client | null = null;

export function useS3ObjectStorage(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID?.trim() &&
      process.env.AWS_SECRET_ACCESS_KEY?.trim() &&
      process.env.S3_BUCKET?.trim(),
  );
}

export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION?.trim() || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!.trim(),
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!.trim(),
      },
    });
  }
  return s3Client;
}

export function s3PrivatePrefix(): string {
  return (process.env.S3_PRIVATE_PREFIX ?? "private").replace(/^\/+|\/+$/g, "");
}

export function s3PublicPrefix(): string {
  return (process.env.S3_PUBLIC_PREFIX ?? "public").replace(/^\/+|\/+$/g, "");
}

export function s3BucketName(): string {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) throw new Error("S3_BUCKET is not set");
  return bucket;
}

function isPermissionAllowed(
  requested: ObjectPermission,
  granted: ObjectPermission,
): boolean {
  if (requested === ObjectPermission.READ) {
    return [ObjectPermission.READ, ObjectPermission.WRITE].includes(granted);
  }
  return granted === ObjectPermission.WRITE;
}

abstract class BaseObjectAccessGroup implements ObjectAccessGroup {
  constructor(
    public readonly type: ObjectAccessGroupType,
    public readonly id: string,
  ) {}

  public abstract hasMember(userId: string): Promise<boolean>;
}

function createObjectAccessGroup(
  group: ObjectAccessGroup,
): BaseObjectAccessGroup {
  switch (group.type) {
    default:
      throw new Error(`Unknown access group type: ${group.type}`);
  }
}

export async function setObjectAclPolicy(
  objectRef: StoredObjectRef,
  aclPolicy: ObjectAclPolicy,
): Promise<void> {
  if (objectRef.provider === "gcs") {
    const [exists] = await objectRef.file.exists();
    if (!exists) {
      throw new Error(`Object not found: ${objectRef.file.name}`);
    }
    await objectRef.file.setMetadata({
      metadata: {
        [GCS_ACL_METADATA_KEY]: JSON.stringify(aclPolicy),
      },
    });
    return;
  }

  const client = getS3Client();
  await client.send(
    new CopyObjectCommand({
      Bucket: objectRef.bucket,
      Key: objectRef.key,
      CopySource: `${objectRef.bucket}/${objectRef.key}`,
      Metadata: {
        [S3_ACL_METADATA_KEY]: JSON.stringify(aclPolicy),
      },
      MetadataDirective: "REPLACE",
    }),
  );
}

export async function getObjectAclPolicy(
  objectRef: StoredObjectRef,
): Promise<ObjectAclPolicy | null> {
  if (objectRef.provider === "gcs") {
    const [metadata] = await objectRef.file.getMetadata();
    const aclPolicy = metadata?.metadata?.[GCS_ACL_METADATA_KEY];
    if (!aclPolicy) return null;
    return JSON.parse(aclPolicy as string) as ObjectAclPolicy;
  }

  const client = getS3Client();
  const head = await client.send(
    new HeadObjectCommand({
      Bucket: objectRef.bucket,
      Key: objectRef.key,
    }),
  );
  const raw = head.Metadata?.[S3_ACL_METADATA_KEY];
  if (!raw) return null;
  return JSON.parse(raw) as ObjectAclPolicy;
}

export async function canAccessObject({
  userId,
  objectRef,
  requestedPermission,
}: {
  userId?: string;
  objectRef: StoredObjectRef;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  const aclPolicy = await getObjectAclPolicy(objectRef);
  if (!aclPolicy) return false;

  if (
    aclPolicy.visibility === "public" &&
    requestedPermission === ObjectPermission.READ
  ) {
    return true;
  }

  if (!userId) return false;
  if (aclPolicy.owner === userId) return true;

  for (const rule of aclPolicy.aclRules || []) {
    const accessGroup = createObjectAccessGroup(rule.group);
    if (
      (await accessGroup.hasMember(userId)) &&
      isPermissionAllowed(requestedPermission, rule.permission)
    ) {
      return true;
    }
  }

  return false;
}

export async function headStoredObject(
  objectRef: StoredObjectRef,
): Promise<{ contentType: string; contentLength?: number }> {
  if (objectRef.provider === "gcs") {
    const [metadata] = await objectRef.file.getMetadata();
    return {
      contentType: (metadata.contentType as string) || "application/octet-stream",
      contentLength: metadata.size ? Number(metadata.size) : undefined,
    };
  }

  const head = await getS3Client().send(
    new HeadObjectCommand({
      Bucket: objectRef.bucket,
      Key: objectRef.key,
    }),
  );
  return {
    contentType: head.ContentType || "application/octet-stream",
    contentLength: head.ContentLength,
  };
}

export async function readStoredObjectBuffer(
  objectRef: StoredObjectRef,
): Promise<Buffer> {
  if (objectRef.provider === "gcs") {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = objectRef.file.createReadStream();
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }

  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: objectRef.bucket,
      Key: objectRef.key,
    }),
  );
  const body = response.Body;
  if (!body) throw new Error("Empty S3 object body");
  if (body instanceof Readable) {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      body.on("data", (c: Buffer) => chunks.push(c));
      body.on("end", () => resolve(Buffer.concat(chunks)));
      body.on("error", reject);
    });
  }
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function openStoredObjectWebStream(
  objectRef: StoredObjectRef,
): Promise<ReadableStream> {
  if (objectRef.provider === "gcs") {
    const nodeStream = objectRef.file.createReadStream();
    return Readable.toWeb(nodeStream) as ReadableStream;
  }

  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: objectRef.bucket,
      Key: objectRef.key,
    }),
  );
  const body = response.Body;
  if (!body) throw new Error("Empty S3 object body");
  if (body instanceof Readable) {
    return Readable.toWeb(body) as ReadableStream;
  }
  const bytes = await body.transformToByteArray();
  return new Response(bytes).body!;
}

export async function storedObjectExists(
  objectRef: StoredObjectRef,
): Promise<boolean> {
  try {
    if (objectRef.provider === "gcs") {
      const [exists] = await objectRef.file.exists();
      return exists;
    }
    await getS3Client().send(
      new HeadObjectCommand({
        Bucket: objectRef.bucket,
        Key: objectRef.key,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
