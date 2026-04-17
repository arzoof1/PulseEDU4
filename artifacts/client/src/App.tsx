import { useEffect } from "react";

function App() {
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.log("Health check response:", data))
      .catch((err) => console.error("Health check failed:", err));
  }, []);

  return (
    <div>
      <h1>School Operations App - MVP</h1>
    </div>
  );
}

export default App;
