export interface HallPass {
  id: number;
  studentId: string;
  destination: string;
  originRoom: string;
  teacherName: string;
  status: "active" | "ended";
  createdAt: string;
  maxDurationMinutes: number;
  endedAt: string | null;
}

export const hallPasses: HallPass[] = [];

let nextId = 1;
export const getNextHallPassId = () => nextId++;
