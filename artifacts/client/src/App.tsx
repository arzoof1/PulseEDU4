import { useEffect, useState } from "react";

const destinationsByRoom: Record<string, string[]> = {
  "Room 101": ["Boys Restroom", "Girls Restroom", "Nurse", "Front Office"],
  "Room 102": ["Boys Restroom", "Girls Restroom", "Front Office"],
  "Room 201": ["Boys Restroom", "Girls Restroom", "Library", "Guidance"],
  "Room 202": ["Boys Restroom", "Girls Restroom", "Nurse"],
  "Room 204": ["Library", "Boys Restroom", "Girls Restroom", "Guidance"],
  "Room 305": ["Boys Restroom", "Girls Restroom", "Media Center", "Front Office"],
  "Gym": ["Nurse", "Front Office", "Cafeteria"],
  "Cafeteria": ["Boys Restroom", "Girls Restroom", "Nurse", "Front Office"],
};

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
  endedAt: string | null;
}

function formatTimeStatus(pass: HallPass, now: number): string {
  if (pass.status === "ended") return "Ended";
  const expiresAt =
    new Date(pass.createdAt).getTime() + pass.maxDurationMinutes * 60 * 1000;
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return "Overdue";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s left`;
}

function App() {
  const [students, setStudents] = useState<Student[]>([]);
  const [hallPasses, setHallPasses] = useState<HallPass[]>([]);

  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [destination, setDestination] = useState("");
  const [originRoom, setOriginRoom] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

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
            Origin Room:{" "}
            <select
              value={originRoom}
              onChange={(e) => {
                const newRoom = e.target.value;
                setOriginRoom(newRoom);
                const allowed = destinationsByRoom[newRoom] ?? [];
                if (destination && !allowed.includes(destination)) {
                  setDestination("");
                }
              }}
              required
            >
              <option value="">-- select an origin room --</option>
              {Object.keys(destinationsByRoom).map((room) => (
                <option key={room} value={room}>
                  {room}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Destination:{" "}
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              required
              disabled={!originRoom}
            >
              <option value="">-- select a destination --</option>
              {(destinationsByRoom[originRoom] ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
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
            <th>Time Status</th>
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
              <td>{formatTimeStatus(p, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
