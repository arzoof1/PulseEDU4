// Shared temp-password generator. CSPRNG over a constrained alphabet so
// the resulting string is unguessable but also easy for a SuperUser /
// Admin to copy out of a "saved" modal and read to the staff member
// over the phone — no look-alike chars (no 0/O, 1/l/I, etc.).
//
// Used by tenancy onboard-district / onboard-school (initial admin
// credential) AND by adminStaff reset-temp-password (regenerate for an
// existing staff member). Keep these two flows in sync — if you change
// the alphabet or length here, every "we saved your temp password" UI
// gets the new shape automatically.

import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";

const ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const LENGTH = 16;

export function generateTempPassword(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

export async function generateAndHashTempPassword(): Promise<{
  tempPassword: string;
  passwordHash: string;
}> {
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  return { tempPassword, passwordHash };
}
