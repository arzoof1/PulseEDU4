export default function BehaviorTeam() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">08 / 18</div>

      <div className="mt-[7vh] max-w-[82vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ROLE 03 / BEHAVIOR TEAM</div>
        <h1 className="mt-[1.5vh] text-[3.6vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          BS, Dean, ISS Teacher, PBIS Coordinator.
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">BEHAVIOR SPECIALIST</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Open a behavior plan for a student by clicking "New Plan" from the BS dashboard.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DEAN</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Assign and track ISS placements by adding the student on the ISS Dashboard.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ISS TEACHER</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Take attendance and log work completion by checking students in on the ISS roster.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">PBIS COORDINATOR</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Configure point values, store items, and house teams by opening Settings → PBIS.</p>
        </div>
        <div className="col-span-2 rounded-[1.2vw] bg-[#F0DEDA] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">WHOLE TEAM · INCIDENT HISTORY</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">View a student's full referral and incident history by opening the Behavior tab on the student profile.</p>
        </div>
      </div>
    </div>
  );
}
