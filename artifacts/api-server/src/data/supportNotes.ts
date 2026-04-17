export interface SupportNote {
  id: number;
  studentId: string;
  noteType: string;
  noteText: string;
  staffName: string;
  createdAt: string;
}

export const supportNotes: SupportNote[] = [];

let nextId = 1;
export const getNextSupportNoteId = () => nextId++;
