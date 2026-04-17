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
  teacherName: string;
  status: string;
  maxDurationMinutes: number;
  createdAt: string;
  endedAt: string | null;
}

const teachers = ["Ms. Rivera", "Mr. Johnson", "Coach Lee"];

interface Tardy {
  id: number;
  studentId: string;
  teacherName: string;
  period: string;
  reason: string;
  entryType: "tardy" | "checkin" | "checkout";
  checkInWith: string | null;
  notes: string;
  createdAt: string;
}

const checkInWithOptions = [
  "Counselor",
  "Interventionist",
  "Behavior Specialist",
  "Trusted Adult",
  "Administrator",
  "Teacher",
  "Other",
];

function getTimeStatusColor(pass: HallPass, now: number): string {
  if (pass.status === "ended") return "gray";
  const totalMs = pass.maxDurationMinutes * 60 * 1000;
  const expiresAt = new Date(pass.createdAt).getTime() + totalMs;
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return "red";
  if (remainingMs < totalMs / 2) return "yellow";
  return "green";
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
  const [tardies, setTardies] = useState<Tardy[]>([]);

  const [selectedTeacher, setSelectedTeacher] = useState(teachers[0]);
  const [passFilter, setPassFilter] = useState<"all" | "mine">("all");
  const [activeSection, setActiveSection] = useState<"hallPasses" | "tardies">(
    "hallPasses",
  );
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [destination, setDestination] = useState("");
  const [originRoom, setOriginRoom] = useState("");

  const [tardyEntryType, setTardyEntryType] = useState<
    "tardy" | "checkin" | "checkout"
  >("tardy");
  const [tardyNotes, setTardyNotes] = useState("");
  const [tardyCreateReturnPass, setTardyCreateReturnPass] = useState(false);
  const [tardyReturnPassTeacher, setTardyReturnPassTeacher] = useState(
    teachers[0],
  );
  const [tardyStudentId, setTardyStudentId] = useState("");
  const [tardyStudentSearch, setTardyStudentSearch] = useState("");
  const [tardyPeriod, setTardyPeriod] = useState("");
  const [tardyReason, setTardyReason] = useState("");
  const [tardyCheckInWith, setTardyCheckInWith] = useState("");
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

    loadTardies();
  }, []);

  const loadTardies = () => {
    fetch("/api/tardies")
      .then((res) => res.json())
      .then((data: Tardy[]) => setTardies(data))
      .catch((err) => console.error("Failed to load tardies:", err));
  };

  const handleTardySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tardyStudentId || !tardyPeriod) return;
    if (
      (tardyEntryType === "checkin" || tardyEntryType === "checkout") &&
      !tardyCheckInWith
    )
      return;
    try {
      const res = await fetch("/api/tardies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: tardyStudentId,
          teacherName: selectedTeacher,
          period: tardyPeriod,
          reason: tardyEntryType === "tardy" ? tardyReason : "",
          entryType: tardyEntryType,
          checkInWith:
            tardyEntryType === "checkin" || tardyEntryType === "checkout"
              ? tardyCheckInWith
              : null,
          notes: tardyNotes,
        }),
      });
      if (!res.ok) {
        console.error("Failed to create tardy:", await res.text());
        return;
      }
      setTardyStudentId("");
      setTardyStudentSearch("");
      setTardyPeriod("");
      setTardyReason("");
      setTardyCheckInWith("");
      setTardyNotes("");

      if (tardyEntryType === "tardy" && tardyCreateReturnPass) {
        try {
          const passRes = await fetch("/api/hall-passes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentId: tardyStudentId,
              destination: "Return to Class",
              originRoom: "Front Office",
              teacherName: tardyReturnPassTeacher,
            }),
          });
          if (!passRes.ok) {
            console.error(
              "Failed to create return pass:",
              await passRes.text(),
            );
          } else {
            loadHallPasses();
          }
        } catch (err) {
          console.error("Failed to create return pass:", err);
        }
      }

      setTardyCreateReturnPass(false);
      setTardyReturnPassTeacher(teachers[0]);
      loadTardies();
    } catch (err) {
      console.error("Failed to create tardy:", err);
    }
  };

  const handleEndPass = async (id: number) => {
    try {
      const res = await fetch(`/api/hall-passes/${id}/end`, {
        method: "PATCH",
      });
      if (!res.ok) {
        console.error("Failed to end hall pass:", await res.text());
        return;
      }
      loadHallPasses();
    } catch (err) {
      console.error("Failed to end hall pass:", err);
    }
  };

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
          teacherName: selectedTeacher,
        }),
      });
      if (!res.ok) {
        console.error("Failed to create hall pass:", await res.text());
        return;
      }
      setDestination("");
      setOriginRoom("");
      setSelectedStudentId("");
      setStudentSearch("");
      loadHallPasses();
    } catch (err) {
      console.error("Failed to create hall pass:", err);
    }
  };

  return (
    <div style={{ padding: "1rem", fontFamily: "sans-serif" }}>
      <h1>School Operations App - MVP</h1>

      <div style={{ marginBottom: "1rem" }}>
        <label>
          Teacher:{" "}
          <select
            value={selectedTeacher}
            onChange={(e) => setSelectedTeacher(e.target.value)}
          >
            {teachers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          onClick={() => setActiveSection("hallPasses")}
          disabled={activeSection === "hallPasses"}
        >
          Hall Passes
        </button>{" "}
        <button
          type="button"
          onClick={() => setActiveSection("tardies")}
          disabled={activeSection === "tardies"}
        >
          Tardy / Check-Ins
        </button>
      </div>

      {activeSection === "hallPasses" && (<>
      {(() => {
        let active = 0;
        let overdue = 0;
        let ended = 0;
        for (const p of hallPasses) {
          if (p.status === "ended") {
            ended++;
          } else if (p.status === "active") {
            const expiresAt =
              new Date(p.createdAt).getTime() +
              p.maxDurationMinutes * 60 * 1000;
            if (now >= expiresAt) overdue++;
            else active++;
          }
        }
        const boxStyle: React.CSSProperties = {
          border: "1px solid #ccc",
          padding: "0.5rem 0.75rem",
          minWidth: "8rem",
        };
        return (
          <section style={{ marginBottom: "1rem" }}>
            <h2>Hall Pass Summary</h2>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <div style={boxStyle}>
                <div>Active Passes</div>
                <strong>{active}</strong>
              </div>
              <div style={boxStyle}>
                <div>Overdue Passes</div>
                <strong>{overdue}</strong>
              </div>
              <div style={boxStyle}>
                <div>Ended Passes</div>
                <strong>{ended}</strong>
              </div>
            </div>
          </section>
        );
      })()}

      <h2>Create Hall Pass</h2>
      <form onSubmit={handleSubmit} style={{ marginBottom: "1rem" }}>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Student:{" "}
            <input
              type="text"
              placeholder="Search by name or ID"
              value={studentSearch}
              onChange={(e) => {
                setStudentSearch(e.target.value);
                setSelectedStudentId("");
              }}
            />
          </label>
          {selectedStudentId ? (
            <div style={{ marginTop: "0.25rem" }}>
              Selected: <strong>{selectedStudentId}</strong>{" "}
              {(() => {
                const s = students.find(
                  (s) => s.studentId === selectedStudentId,
                );
                return s ? `- ${s.firstName} ${s.lastName}` : "";
              })()}{" "}
              <button
                type="button"
                onClick={() => {
                  setSelectedStudentId("");
                  setStudentSearch("");
                }}
              >
                Clear
              </button>
            </div>
          ) : (
            studentSearch && (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "0.25rem 0",
                  border: "1px solid #ccc",
                  maxWidth: "20rem",
                }}
              >
                {students
                  .filter((s) => {
                    const q = studentSearch.toLowerCase();
                    return (
                      s.firstName.toLowerCase().includes(q) ||
                      s.lastName.toLowerCase().includes(q) ||
                      s.studentId.toLowerCase().includes(q)
                    );
                  })
                  .map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "0.25rem 0.5rem",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          setSelectedStudentId(s.studentId);
                          setStudentSearch(
                            `${s.studentId} - ${s.firstName} ${s.lastName}`,
                          );
                        }}
                      >
                        {s.studentId} - {s.firstName} {s.lastName}
                      </button>
                    </li>
                  ))}
                {students.filter((s) => {
                  const q = studentSearch.toLowerCase();
                  return (
                    s.firstName.toLowerCase().includes(q) ||
                    s.lastName.toLowerCase().includes(q) ||
                    s.studentId.toLowerCase().includes(q)
                  );
                }).length === 0 && (
                  <li style={{ padding: "0.25rem 0.5rem", color: "#666" }}>
                    No matches
                  </li>
                )}
              </ul>
            )
          )}
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
      <div style={{ marginBottom: "0.5rem" }}>
        <button
          type="button"
          onClick={() => setPassFilter("all")}
          disabled={passFilter === "all"}
        >
          All Passes
        </button>{" "}
        <button
          type="button"
          onClick={() => setPassFilter("mine")}
          disabled={passFilter === "mine"}
        >
          My Passes
        </button>
      </div>
      <table border={1} cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>studentId</th>
            <th>teacher</th>
            <th>destination</th>
            <th>originRoom</th>
            <th>status</th>
            <th>maxDurationMinutes</th>
            <th>createdAt</th>
            <th>Time Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {hallPasses
            .filter((p) =>
              passFilter === "mine" ? p.teacherName === selectedTeacher : true,
            )
            .map((p) => (
            <tr key={p.id}>
              <td>{p.studentId}</td>
              <td>{p.teacherName}</td>
              <td>{p.destination}</td>
              <td>{p.originRoom}</td>
              <td>{p.status}</td>
              <td>{p.maxDurationMinutes}</td>
              <td>{p.createdAt}</td>
              <td style={{ backgroundColor: getTimeStatusColor(p, now) }}>
                {formatTimeStatus(p, now)}
              </td>
              <td>
                {p.status === "active" ? (
                  <button onClick={() => handleEndPass(p.id)}>End Pass</button>
                ) : (
                  "-"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </>)}

      {activeSection === "tardies" && (<>
      <h2>Log Tardy / Check-In</h2>
      <form onSubmit={handleTardySubmit} style={{ marginBottom: "1rem" }}>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Entry Type:{" "}
            <select
              value={tardyEntryType}
              onChange={(e) =>
                setTardyEntryType(
                  e.target.value as "tardy" | "checkin" | "checkout",
                )
              }
            >
              <option value="tardy">Tardy</option>
              <option value="checkin">Check-In</option>
              <option value="checkout">Check-Out</option>
            </select>
          </label>
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Student:{" "}
            <input
              type="text"
              placeholder="Search by name or ID"
              value={tardyStudentSearch}
              onChange={(e) => {
                setTardyStudentSearch(e.target.value);
                setTardyStudentId("");
              }}
            />
          </label>
          {tardyStudentId ? (
            <div style={{ marginTop: "0.25rem" }}>
              Selected: <strong>{tardyStudentId}</strong>{" "}
              {(() => {
                const s = students.find(
                  (s) => s.studentId === tardyStudentId,
                );
                return s ? `- ${s.firstName} ${s.lastName}` : "";
              })()}{" "}
              <button
                type="button"
                onClick={() => {
                  setTardyStudentId("");
                  setTardyStudentSearch("");
                }}
              >
                Clear
              </button>
            </div>
          ) : (
            tardyStudentSearch && (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "0.25rem 0",
                  border: "1px solid #ccc",
                  maxWidth: "20rem",
                }}
              >
                {students
                  .filter((s) => {
                    const q = tardyStudentSearch.toLowerCase();
                    return (
                      s.firstName.toLowerCase().includes(q) ||
                      s.lastName.toLowerCase().includes(q) ||
                      s.studentId.toLowerCase().includes(q)
                    );
                  })
                  .map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "0.25rem 0.5rem",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          setTardyStudentId(s.studentId);
                          setTardyStudentSearch(
                            `${s.studentId} - ${s.firstName} ${s.lastName}`,
                          );
                        }}
                      >
                        {s.studentId} - {s.firstName} {s.lastName}
                      </button>
                    </li>
                  ))}
                {students.filter((s) => {
                  const q = tardyStudentSearch.toLowerCase();
                  return (
                    s.firstName.toLowerCase().includes(q) ||
                    s.lastName.toLowerCase().includes(q) ||
                    s.studentId.toLowerCase().includes(q)
                  );
                }).length === 0 && (
                  <li style={{ padding: "0.25rem 0.5rem", color: "#666" }}>
                    No matches
                  </li>
                )}
              </ul>
            )
          )}
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Period:{" "}
            <select
              value={tardyPeriod}
              onChange={(e) => setTardyPeriod(e.target.value)}
              required
            >
              <option value="">-- select a period --</option>
              {["1", "2", "3", "4", "5", "6", "7"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
        {tardyEntryType === "tardy" && (
          <div style={{ marginBottom: "0.5rem" }}>
            <label>
              Reason:{" "}
              <input
                type="text"
                value={tardyReason}
                onChange={(e) => setTardyReason(e.target.value)}
              />
            </label>
          </div>
        )}
        {tardyEntryType === "tardy" && (
          <div style={{ marginBottom: "0.5rem" }}>
            <label>
              <input
                type="checkbox"
                checked={tardyCreateReturnPass}
                onChange={(e) => setTardyCreateReturnPass(e.target.checked)}
              />{" "}
              Create return pass to class
            </label>
            {tardyCreateReturnPass && (
              <div style={{ marginTop: "0.25rem" }}>
                <label>
                  Receiving Teacher:{" "}
                  <select
                    value={tardyReturnPassTeacher}
                    onChange={(e) => setTardyReturnPassTeacher(e.target.value)}
                  >
                    {teachers.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
        )}
        {(tardyEntryType === "checkin" || tardyEntryType === "checkout") && (
          <div style={{ marginBottom: "0.5rem" }}>
            <label>
              {tardyEntryType === "checkin" ? "Check-In With:" : "Check-Out With:"}{" "}
              <select
                value={tardyCheckInWith}
                onChange={(e) => setTardyCheckInWith(e.target.value)}
                required
              >
                <option value="">-- select --</option>
                {checkInWithOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Notes (optional):{" "}
            <input
              type="text"
              value={tardyNotes}
              onChange={(e) => setTardyNotes(e.target.value)}
            />
          </label>
        </div>
        <button type="submit">
          {tardyEntryType === "tardy"
            ? "Log Tardy"
            : tardyEntryType === "checkin"
              ? "Log Check-In"
              : "Log Check-Out"}
        </button>
      </form>

      <h2>Tardy / Check-Ins</h2>
      <table border={1} cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>studentId</th>
            <th>teacherName</th>
            <th>entryType</th>
            <th>period</th>
            <th>reason</th>
            <th>checkInWith</th>
            <th>notes</th>
            <th>createdAt</th>
          </tr>
        </thead>
        <tbody>
          {tardies.map((t) => (
            <tr key={t.id}>
              <td>{t.studentId}</td>
              <td>{t.teacherName}</td>
              <td>{t.entryType}</td>
              <td>{t.period}</td>
              <td>{t.reason}</td>
              <td>{t.checkInWith ?? "-"}</td>
              <td>{t.notes}</td>
              <td>{t.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </>)}
    </div>
  );
}

export default App;
