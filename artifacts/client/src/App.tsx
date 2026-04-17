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
  originRoom: string;
  status: string;
  maxDurationMinutes: number;
  createdAt: string;
}

function App() {
  const [students, setStudents] = useState<Student[]>([]);
  const [hallPasses, setHallPasses] = useState<HallPass[]>([]);

  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [destination, setDestination] = useState("");
  const [originRoom, setOriginRoom] = useState("");

  const loadHallPasses = () => {
    fetch("/api/hall-passes")
      .then((res) => res.json())
      .then((data: HallPass[]) => setHallPasses(data))
      .catch((err) => console.error("Failed to load hall passes:", err));
  };

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.log("Health check response:", data))
      .catch((err) => console.error("Health check failed:", err));

    fetch("/api/students")
      .then((res) => res.json())
      .then((data: Student[]) => setStudents(data))
      .catch((err) => console.error("Failed to load students:", err));

    loadHallPasses();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStudentId || !destination || !originRoom) return;

    try {
      const res = await fetch("/api/hall-passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: selectedStudentId,
          destination,
          originRoom,
        }),
      });
      if (!res.ok) {
        console.error("Failed to create hall pass:", await res.text());
        return;
      }
      setDestination("");
      setOriginRoom("");
      loadHallPasses();
    } catch (err) {
      console.error("Failed to create hall pass:", err);
    }
  };

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

      <h2>Create Hall Pass</h2>
      <form onSubmit={handleSubmit} style={{ marginBottom: "1rem" }}>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Student:{" "}
            <select
              value={selectedStudentId}
              onChange={(e) => setSelectedStudentId(e.target.value)}
              required
            >
              <option value="">-- select a student --</option>
              {students.map((s) => (
                <option key={s.id} value={s.studentId}>
                  {s.studentId} - {s.firstName} {s.lastName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Destination:{" "}
            <input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              required
            />
          </label>
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Origin Room:{" "}
            <input
              type="text"
              value={originRoom}
              onChange={(e) => setOriginRoom(e.target.value)}
              required
            />
          </label>
        </div>
        <button type="submit">Create</button>
      </form>

      <h2>Hall Passes</h2>
      <table border={1} cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>studentId</th>
            <th>destination</th>
            <th>originRoom</th>
            <th>status</th>
            <th>maxDurationMinutes</th>
            <th>createdAt</th>
          </tr>
        </thead>
        <tbody>
          {hallPasses.map((p) => (
            <tr key={p.id}>
              <td>{p.studentId}</td>
              <td>{p.destination}</td>
              <td>{p.originRoom}</td>
              <td>{p.status}</td>
              <td>{p.maxDurationMinutes}</td>
              <td>{p.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
