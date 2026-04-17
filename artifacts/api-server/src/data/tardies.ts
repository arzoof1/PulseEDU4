export interface Tardy {
  id: number;
  studentId: string;
  teacherName: string;
  period: string;
  reason: string;
  entryType: "tardy" | "checkin" | "checkout";
  checkInWith: string | null;
  notes: string;
  createdAt: string;
}

export const tardies: Tardy[] = [];

let nextId = 1;
export const getNextTardyId = () => nextId++;
