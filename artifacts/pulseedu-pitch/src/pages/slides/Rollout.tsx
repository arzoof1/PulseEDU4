export default function Rollout() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[5vh]">
      <div className="absolute top-[4vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[4vh] right-[6vw] text-[1.2vw] text-[#888]">17 / 18</div>

      <div className="mt-[6vh] max-w-[85vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ROLLOUT</div>
        <h1 className="mt-[1vh] text-[3.8vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          The first 90 days.
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-5 gap-[1.2vw]">
        <div className="rounded-[1vw] bg-[#E0E7ED] px-[1.3vw] py-[2.5vh] h-[48vh] flex flex-col">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DAY 0</div>
          <div className="mt-[1vh] text-[2vw] font-extrabold leading-[1.05]">Kickoff</div>
          <p className="mt-auto text-[1.25vw] leading-[1.35] text-pretty">Confirm tier and module list with the district.</p>
        </div>
        <div className="rounded-[1vw] bg-[#E1EDE4] px-[1.3vw] py-[2.5vh] h-[48vh] flex flex-col">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DAY 7</div>
          <div className="mt-[1vh] text-[2vw] font-extrabold leading-[1.05]">Rosters in</div>
          <p className="mt-auto text-[1.25vw] leading-[1.35] text-pretty">Imports complete. Accounts created. Roles assigned.</p>
        </div>
        <div className="rounded-[1vw] bg-[#F0E4D8] px-[1.3vw] py-[2.5vh] h-[48vh] flex flex-col">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DAY 30</div>
          <div className="mt-[1vh] text-[2vw] font-extrabold leading-[1.05]">Live in school</div>
          <p className="mt-auto text-[1.25vw] leading-[1.35] text-pretty">Behavior team and teachers fully trained. Kiosks live.</p>
        </div>
        <div className="rounded-[1vw] bg-[#E8E0ED] px-[1.3vw] py-[2.5vh] h-[48vh] flex flex-col">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DAY 60</div>
          <div className="mt-[1vh] text-[2vw] font-extrabold leading-[1.05]">Families in</div>
          <p className="mt-auto text-[1.25vw] leading-[1.35] text-pretty">Parent portal opened. First weekly digest goes out.</p>
        </div>
        <div className="rounded-[1vw] bg-[#F0DEDA] px-[1.3vw] py-[2.5vh] h-[48vh] flex flex-col">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DAY 90</div>
          <div className="mt-[1vh] text-[2vw] font-extrabold leading-[1.05]">First review</div>
          <p className="mt-auto text-[1.25vw] leading-[1.35] text-pretty">Leadership reviews referrals, watchlist, and intervention completion.</p>
        </div>
      </div>
    </div>
  );
}
