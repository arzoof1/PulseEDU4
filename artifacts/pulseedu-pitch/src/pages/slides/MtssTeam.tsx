export default function MtssTeam() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[5vh]">
      <div className="absolute top-[4vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[4vh] right-[6vw] text-[1.2vw] text-[#888]">09 / 18</div>

      <div className="mt-[6vh] max-w-[85vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ROLE 04 / STUDENT SUPPORT</div>
        <h1 className="mt-[1vh] text-[3.2vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          MTSS Coord, Counselor, Social Worker, Psych, ESE Coord.
        </h1>
      </div>

      <div className="mt-[4vh] grid grid-cols-2 gap-x-[2vw] gap-y-[1.8vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[2.2vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">MTSS COORDINATOR</div>
          <p className="mt-[0.8vh] text-[1.45vw] leading-[1.35] text-pretty">Build a tiered intervention plan for a student by clicking "New MTSS Plan" on the student profile.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[2.2vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">COUNSELOR / SOCIAL WORKER</div>
          <p className="mt-[0.8vh] text-[1.45vw] leading-[1.35] text-pretty">Log a pullout session by selecting the student and writing a note in the MTSS Plans tab.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[2.2vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ESE COORDINATOR</div>
          <p className="mt-[0.8vh] text-[1.45vw] leading-[1.35] text-pretty">Manage IEP accommodations and verify that teachers are logging them by opening the Accommodations dashboard.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[2.2vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">SCHOOL PSYCHOLOGIST</div>
          <p className="mt-[0.8vh] text-[1.45vw] leading-[1.35] text-pretty">Flag a student to the Early Warning watchlist by clicking "Add to Watchlist" on the student profile.</p>
        </div>
        <div className="col-span-2 rounded-[1.2vw] bg-[#F0DEDA] px-[2vw] py-[2.2vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">WHOLE TEAM · WEEKLY TRIAGE</div>
          <p className="mt-[0.8vh] text-[1.45vw] leading-[1.35] text-pretty">See who is owed what intervention this week by opening the MTSS dashboard.</p>
        </div>
      </div>
    </div>
  );
}
