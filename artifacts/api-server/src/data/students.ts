export interface Student {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
  parentName: string | null;
  parentEmail: string | null;
  parentPhone: string | null;
  accommodations: string[];
}

export const students: Student[] = [
  { id: 1, studentId: "S1001", firstName: "Ava",     lastName: "Johnson",   grade: 9,  parentName: "Karen Johnson",  parentEmail: "karen.johnson@example.com",  parentPhone: "555-201-1001", accommodations: ["Extended Time", "Preferential Seating", "Check for Understanding"] },
  { id: 2, studentId: "S1002", firstName: "Liam",    lastName: "Martinez",  grade: 10, parentName: "Carlos Martinez", parentEmail: "carlos.martinez@example.com", parentPhone: "555-201-1002", accommodations: ["Small Group Testing", "Read Aloud Directions"] },
  { id: 3, studentId: "S1003", firstName: "Sophia",  lastName: "Nguyen",    grade: 11, parentName: "Linh Nguyen",     parentEmail: null,                          parentPhone: "555-201-1003", accommodations: ["Frequent Breaks", "Reduced Distractions", "Copies of Notes"] },
  { id: 4, studentId: "S1004", firstName: "Noah",    lastName: "Patel",     grade: 12, parentName: "Anika Patel",     parentEmail: "anika.patel@example.com",     parentPhone: null,           accommodations: ["Extended Time"] },
  { id: 5, studentId: "S1005", firstName: "Mia",     lastName: "Brown",     grade: 9,  parentName: null,              parentEmail: null,                          parentPhone: null,           accommodations: [] },
];
