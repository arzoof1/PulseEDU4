export default function DailyOperations() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">14 / 18</div>

      <div className="mt-[7vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">MODULE GROUP 03 · 4 MODULES</div>
        <h1 className="mt-[1.5vh] text-[4.5vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          Daily Operations.
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2.5vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">HALL PASSES</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">Kiosk or teacher-issued, with caps per student per day.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">TARDY PASS</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">ID-scan check-in, automatic referral on the Nth tardy.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">BELL SCHEDULE</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">Per-school, per-day-type — drives kiosk behavior automatically.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DISPLAYS</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">Wall-mounted signage for hallways, cafeteria, and front office — including House leaderboards.</p>
        </div>
      </div>
    </div>
  );
}
