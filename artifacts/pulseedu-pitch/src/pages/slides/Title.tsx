export default function Title() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">Confidential pitch · 2026</div>

      <div className="mt-[10vh] flex h-[78vh]">
        <div className="flex-1 flex flex-col justify-center pr-[4vw]">
          <h1 className="text-[8vw] font-extrabold leading-[1.02] tracking-[-0.04em] text-balance">
            PulseEDU
          </h1>
          <p className="mt-[4vh] max-w-[40vw] text-[1.8vw] leading-[1.4] text-[#5A5A6E] text-pretty">
            One platform for every adult in your building. A school operations system built for principals, teachers, behavior teams, MTSS coordinators, and families.
          </p>
          <div className="mt-auto text-[1vw] text-[#999]">
            School Pitch Deck — 2026
          </div>
        </div>

        <div className="w-[35vw] flex flex-col justify-center gap-[3vh]">
          <div className="rounded-[1.5vw] bg-[#E0E7ED] px-[3vw] py-[3vh] flex items-center justify-between shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="text-[5vw] font-extrabold tracking-[-0.05em] text-[#1A1A2E]">01</div>
            <div className="text-[1.2vw] font-bold tracking-[0.1em] text-[#5A5A6E]">18 MODULES</div>
          </div>
          <div className="rounded-[1.5vw] bg-[#E1EDE4] px-[3vw] py-[3vh] flex items-center justify-between shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="text-[5vw] font-extrabold tracking-[-0.05em] text-[#1A1A2E]">02</div>
            <div className="text-[1.2vw] font-bold tracking-[0.1em] text-[#5A5A6E]">5 AUDIENCES</div>
          </div>
          <div className="rounded-[1.5vw] bg-[#F0E4D8] px-[3vw] py-[3vh] flex items-center justify-between shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="text-[5vw] font-extrabold tracking-[-0.05em] text-[#1A1A2E]">03</div>
            <div className="text-[1.2vw] font-bold tracking-[0.1em] text-[#5A5A6E]">3 TIERS</div>
          </div>
        </div>
      </div>
    </div>
  );
}
