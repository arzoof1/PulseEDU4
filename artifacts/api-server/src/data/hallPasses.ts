export interface HallPass {
  id: number;
  studentId: string;
  destination: string;
  status: "active" | "ended";
  createdAt: string;
}

export const hallPasses: HallPass[] = [];

let nextId = 1;
export const getNextHallPassId = () => nextId++;
