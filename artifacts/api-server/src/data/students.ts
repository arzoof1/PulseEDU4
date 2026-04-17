export interface Student {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
}

export const students: Student[] = [
  { id: 1, studentId: "S1001", firstName: "Ava",     lastName: "Johnson",   grade: 9  },
  { id: 2, studentId: "S1002", firstName: "Liam",    lastName: "Martinez",  grade: 10 },
  { id: 3, studentId: "S1003", firstName: "Sophia",  lastName: "Nguyen",    grade: 11 },
  { id: 4, studentId: "S1004", firstName: "Noah",    lastName: "Patel",     grade: 12 },
  { id: 5, studentId: "S1005", firstName: "Mia",     lastName: "Brown",     grade: 9  },
];
