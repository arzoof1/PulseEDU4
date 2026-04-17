import { useEffect, useState } from "react";

interface Student {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
}

interface HallPass {
  id: number;
  studentId: string;
  destination: string;
  status: string;
  createdAt: string;
}

function App() {
  const [students, setStudents] = useState<Student[]>([]);
  const [hallPasses, setHallPasses] = useState<HallPass[]>([]);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.log("Health check response:", data))
      .catch((err) => console.error("Health check failed:", err));

    fetch("/api/students")
      .then((res) => res.json())
      .then((data: Student[]) => setStudents(data))
      .catch((err) => console.error("Failed to load students:", err));

    fetch("/api/hall-passes")
      .then((res) => res.json())
      .then((data: HallPass[]) => setHallPasses(data))
      .catch((err) => console.error("Failed to load hall passes:", err));
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

      <h2>Hall Passes</h2>
      <table border={1} cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>id</th>
            <th>studentId</th>
            <th>destination</th>
            <th>status</th>
            <th>createdAt</th>
          </tr>
        </thead>
        <tbody>
          {hallPasses.map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td>
              <td>{p.studentId}</td>
              <td>{p.destination}</td>
              <td>{p.status}</td>
              <td>{p.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
