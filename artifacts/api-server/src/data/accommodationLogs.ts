export interface AccommodationLog {
  id: number;
  studentId: string;
  accommodation: string;
  period: number | null;
  staffName: string;
  createdAt: string;
}

export const accommodationLogs: AccommodationLog[] = [];

let nextId = 1;
export const getNextAccommodationLogId = () => nextId++;
