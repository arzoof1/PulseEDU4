export default function BehaviorPbis() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">12 / 18</div>

      <div className="mt-[7vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">MODULE GROUP 01 · 4 MODULES</div>
        <h1 className="mt-[1.5vh] text-[4.5vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          Behavior & PBIS.
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2.5vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">PBIS POINTS & STORE</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">Teachers award points; students spend them in the school store on real items or digital privileges.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">HOUSES</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">School-wide team competitions tied to point totals — visible everywhere.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ISS DASHBOARD</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">Placement, attendance, and work completion in one view for the Dean and ISS Teacher.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">BEHAVIOR SPECIALIST WORKSPACE</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">Caseload, plans, and progress notes in a single workspace.</p>
        </div>
      </div>
    </div>
  );
}
