// Re-export ACL helpers — implementation lives in storedObject.ts (GCS + S3).
export {
  ObjectAccessGroupType,
  ObjectPermission,
  type ObjectAccessGroup,
  type ObjectAclPolicy,
  type ObjectAclRule,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./storedObject.js";
