export interface PbisEntry {
  id: number;
  studentId: string;
  reason: string;
  points: number;
  createdAt: string;
}

export const pbisEntries: PbisEntry[] = [];

let nextId = 1;
export const getNextPbisId = () => nextId++;
