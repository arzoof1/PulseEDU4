export interface Tardy {
  id: number;
  studentId: string;
  teacherName: string;
  period: string;
  reason: string;
  createdAt: string;
}

export const tardies: Tardy[] = [];

let nextId = 1;
export const getNextTardyId = () => nextId++;
