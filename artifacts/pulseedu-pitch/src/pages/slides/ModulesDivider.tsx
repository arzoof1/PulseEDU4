export default function ModulesDivider() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#1A1A2E] text-[#F0F2F5] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight text-[#F0F2F5]">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">11 / 18</div>

      <div className="mt-[18vh] flex items-end gap-[4vw]">
        <div className="text-[14vw] font-extrabold leading-[0.85] tracking-[-0.05em] text-[#F0E4D8]">18</div>
        <div className="pb-[3vh]">
          <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#888]">PART TWO</div>
          <h1 className="mt-[1vh] text-[5vw] font-extrabold leading-[1.02] tracking-[-0.03em] text-balance">
            Modules. Four groups.
          </h1>
        </div>
      </div>

      <div className="mt-[10vh] grid grid-cols-4 gap-[1.5vw]">
        <div className="rounded-[1vw] bg-[#E0E7ED] text-[#1A1A2E] px-[1.5vw] py-[2.5vh] text-center text-[1.4vw] font-bold">Behavior & PBIS</div>
        <div className="rounded-[1vw] bg-[#E1EDE4] text-[#1A1A2E] px-[1.5vw] py-[2.5vh] text-center text-[1.4vw] font-bold">MTSS & Interventions</div>
        <div className="rounded-[1vw] bg-[#F0E4D8] text-[#1A1A2E] px-[1.5vw] py-[2.5vh] text-center text-[1.4vw] font-bold">Daily Operations</div>
        <div className="rounded-[1vw] bg-[#E8E0ED] text-[#1A1A2E] px-[1.5vw] py-[2.5vh] text-center text-[1.4vw] font-bold">Communication & Data</div>
      </div>
    </div>
  );
}
