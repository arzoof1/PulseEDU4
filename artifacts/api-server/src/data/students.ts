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
  { id: 1,  studentId: "S1001", firstName: "Ava",      lastName: "Johnson",   grade: 9,  parentName: "Karen Johnson",   parentEmail: "karen.johnson@example.com",   parentPhone: "555-201-1001", accommodations: ["Extended Time", "Preferential Seating", "Check for Understanding"] },
  { id: 2,  studentId: "S1002", firstName: "Liam",     lastName: "Martinez",  grade: 10, parentName: "Carlos Martinez", parentEmail: "carlos.martinez@example.com", parentPhone: "555-201-1002", accommodations: ["Small Group Testing", "Read Aloud Directions"] },
  { id: 3,  studentId: "S1003", firstName: "Sophia",   lastName: "Nguyen",    grade: 11, parentName: "Linh Nguyen",     parentEmail: null,                          parentPhone: "555-201-1003", accommodations: ["Frequent Breaks", "Reduced Distractions", "Copies of Notes"] },
  { id: 4,  studentId: "S1004", firstName: "Noah",     lastName: "Patel",     grade: 12, parentName: "Anika Patel",     parentEmail: "anika.patel@example.com",     parentPhone: null,           accommodations: ["Extended Time"] },
  { id: 5,  studentId: "S1005", firstName: "Mia",      lastName: "Brown",     grade: 9,  parentName: null,              parentEmail: null,                          parentPhone: null,           accommodations: [] },
  { id: 6,  studentId: "S1006", firstName: "Ethan",    lastName: "Garcia",    grade: 9,  parentName: "Maria Garcia",    parentEmail: "maria.garcia@example.com",    parentPhone: "555-201-1006", accommodations: ["Extended Time", "Small Group Testing"] },
  { id: 7,  studentId: "S1007", firstName: "Olivia",   lastName: "Smith",     grade: 10, parentName: "John Smith",      parentEmail: "john.smith@example.com",      parentPhone: "555-201-1007", accommodations: [] },
  { id: 8,  studentId: "S1008", firstName: "Lucas",    lastName: "Davis",     grade: 11, parentName: "Tina Davis",      parentEmail: null,                          parentPhone: "555-201-1008", accommodations: ["Preferential Seating"] },
  { id: 9,  studentId: "S1009", firstName: "Isabella", lastName: "Lopez",     grade: 12, parentName: "Jose Lopez",      parentEmail: "jose.lopez@example.com",      parentPhone: "555-201-1009", accommodations: ["Read Aloud Directions", "Copies of Notes"] },
  { id: 10, studentId: "S1010", firstName: "Mason",    lastName: "Wilson",    grade: 9,  parentName: "Beth Wilson",     parentEmail: "beth.wilson@example.com",     parentPhone: null,           accommodations: ["Frequent Breaks"] },
  { id: 11, studentId: "S1011", firstName: "Charlotte",lastName: "Anderson",  grade: 10, parentName: null,              parentEmail: null,                          parentPhone: null,           accommodations: [] },
  { id: 12, studentId: "S1012", firstName: "Logan",    lastName: "Thomas",    grade: 11, parentName: "Pat Thomas",      parentEmail: "pat.thomas@example.com",      parentPhone: "555-201-1012", accommodations: ["Extended Time", "Reduced Distractions"] },
  { id: 13, studentId: "S1013", firstName: "Amelia",   lastName: "Taylor",    grade: 12, parentName: "Sam Taylor",      parentEmail: null,                          parentPhone: "555-201-1013", accommodations: ["Check for Understanding"] },
  { id: 14, studentId: "S1014", firstName: "Elijah",   lastName: "Moore",     grade: 9,  parentName: "Dana Moore",      parentEmail: "dana.moore@example.com",      parentPhone: "555-201-1014", accommodations: ["Small Group Testing", "Extended Time", "Preferential Seating"] },
  { id: 15, studentId: "S1015", firstName: "Harper",   lastName: "Jackson",   grade: 10, parentName: "Eve Jackson",     parentEmail: "eve.jackson@example.com",     parentPhone: null,           accommodations: [] },
  { id: 16, studentId: "S1016", firstName: "James",    lastName: "White",     grade: 11, parentName: "Greg White",      parentEmail: "greg.white@example.com",      parentPhone: "555-201-1016", accommodations: ["Copies of Notes"] },
  { id: 17, studentId: "S1017", firstName: "Evelyn",   lastName: "Harris",    grade: 12, parentName: null,              parentEmail: null,                          parentPhone: null,           accommodations: ["Frequent Breaks", "Reduced Distractions"] },
  { id: 18, studentId: "S1018", firstName: "Benjamin", lastName: "Clark",     grade: 9,  parentName: "Rita Clark",      parentEmail: "rita.clark@example.com",      parentPhone: "555-201-1018", accommodations: ["Read Aloud Directions"] },
  { id: 19, studentId: "S1019", firstName: "Abigail",  lastName: "Lewis",     grade: 10, parentName: "Tom Lewis",       parentEmail: null,                          parentPhone: "555-201-1019", accommodations: ["Extended Time"] },
  { id: 20, studentId: "S1020", firstName: "Henry",    lastName: "Walker",    grade: 11, parentName: "Sue Walker",      parentEmail: "sue.walker@example.com",      parentPhone: "555-201-1020", accommodations: [] },
  { id: 21, studentId: "S1021", firstName: "Emily",    lastName: "Hall",      grade: 12, parentName: "Bill Hall",       parentEmail: "bill.hall@example.com",       parentPhone: null,           accommodations: ["Preferential Seating", "Check for Understanding"] },
  { id: 22, studentId: "S1022", firstName: "Alexander",lastName: "Young",     grade: 9,  parentName: "Joy Young",       parentEmail: null,                          parentPhone: "555-201-1022", accommodations: ["Small Group Testing"] },
  { id: 23, studentId: "S1023", firstName: "Ella",     lastName: "King",      grade: 10, parentName: null,              parentEmail: null,                          parentPhone: null,           accommodations: ["Extended Time", "Frequent Breaks"] },
  { id: 24, studentId: "S1024", firstName: "Daniel",   lastName: "Wright",    grade: 11, parentName: "Ken Wright",      parentEmail: "ken.wright@example.com",      parentPhone: "555-201-1024", accommodations: [] },
  { id: 25, studentId: "S1025", firstName: "Scarlett", lastName: "Scott",     grade: 12, parentName: "Lee Scott",       parentEmail: "lee.scott@example.com",       parentPhone: "555-201-1025", accommodations: ["Copies of Notes", "Reduced Distractions"] },
  { id: 26, studentId: "S1026", firstName: "Matthew",  lastName: "Green",     grade: 9,  parentName: "Amy Green",       parentEmail: null,                          parentPhone: "555-201-1026", accommodations: ["Extended Time"] },
  { id: 27, studentId: "S1027", firstName: "Grace",    lastName: "Adams",     grade: 10, parentName: "Ron Adams",       parentEmail: "ron.adams@example.com",       parentPhone: null,           accommodations: ["Read Aloud Directions", "Preferential Seating"] },
  { id: 28, studentId: "S1028", firstName: "Jack",     lastName: "Baker",     grade: 11, parentName: null,              parentEmail: null,                          parentPhone: null,           accommodations: [] },
  { id: 29, studentId: "S1029", firstName: "Chloe",    lastName: "Nelson",    grade: 12, parentName: "Meg Nelson",      parentEmail: "meg.nelson@example.com",      parentPhone: "555-201-1029", accommodations: ["Check for Understanding", "Extended Time"] },
  { id: 30, studentId: "S1030", firstName: "Sebastian",lastName: "Carter",    grade: 9,  parentName: "Dan Carter",      parentEmail: "dan.carter@example.com",      parentPhone: "555-201-1030", accommodations: ["Small Group Testing", "Frequent Breaks"] },
];
