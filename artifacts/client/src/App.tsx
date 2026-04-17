import { useEffect, useState } from "react";

interface Student {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
}

function App() {
  const [students, setStudents] = useState<Student[]>([]);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.log("Health check response:", data))
      .catch((err) => console.error("Health check failed:", err));

    fetch("/api/students")
      .then((res) => res.json())
      .then((data: Student[]) => setStudents(data))
      .catch((err) => console.error("Failed to load students:", err));
  }, []);

  return (
    <div style={{ padding: "1rem", fontFamily: "sans-serif" }}>
      <h1>School Operations App - MVP</h1>
      <h2>Students</h2>
      <table border={1} cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>studentId</th>
            <th>firstName</th>
            <th>lastName</th>
            <th>grade</th>
          </tr>
        </thead>
        <tbody>
          {students.map((s) => (
            <tr key={s.id}>
              <td>{s.studentId}</td>
              <td>{s.firstName}</td>
              <td>{s.lastName}</td>
              <td>{s.grade}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
