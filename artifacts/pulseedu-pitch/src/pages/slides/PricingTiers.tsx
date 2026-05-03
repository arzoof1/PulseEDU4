export default function PricingTiers() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[5vh]">
      <div className="absolute top-[4vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[4vh] right-[6vw] text-[1.2vw] text-[#888]">16 / 18</div>

      <div className="mt-[6vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">PRICING</div>
        <h1 className="mt-[1vh] text-[4vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          Three tiers.
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-3 gap-[1.8vw] h-[60vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[1.8vw] py-[3vh] flex flex-col">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">TIER 01</div>
          <div className="mt-[0.5vh] text-[3vw] font-extrabold tracking-[-0.03em]">Basic</div>
          <div className="text-[1.2vw] text-[#5A5A6E]">4 modules</div>
          <div className="mt-[2.5vh] h-px bg-[#1A1A2E]/15"></div>
          <p className="mt-[2vh] text-[1.3vw] leading-[1.5] text-pretty">PBIS Points & Store. Hall Passes. Tardy Pass. Family Comm.</p>
          <p className="mt-auto text-[1.1vw] text-[#5A5A6E] leading-[1.4]">For schools just getting started.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[1.8vw] py-[3vh] flex flex-col">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">TIER 02 · MOST POPULAR</div>
          <div className="mt-[0.5vh] text-[3vw] font-extrabold tracking-[-0.03em]">Pro</div>
          <div className="text-[1.2vw] text-[#5A5A6E]">14 modules</div>
          <div className="mt-[2.5vh] h-px bg-[#1A1A2E]/15"></div>
          <p className="mt-[2vh] text-[1.3vw] leading-[1.5] text-pretty">Basic plus MTSS Plans, Behavior Specialist, ISS Dashboard, Displays, Bell Schedule, Early Warning, Academics, Houses, Parent Portal, Accommodations.</p>
          <p className="mt-auto text-[1.1vw] text-[#5A5A6E] leading-[1.4]">For most K-12 schools.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[1.8vw] py-[3vh] flex flex-col">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">TIER 03</div>
          <div className="mt-[0.5vh] text-[3vw] font-extrabold tracking-[-0.03em]">Enterprise</div>
          <div className="text-[1.2vw] text-[#5A5A6E]">All 18 modules</div>
          <div className="mt-[2.5vh] h-px bg-[#1A1A2E]/15"></div>
          <p className="mt-[2vh] text-[1.3vw] leading-[1.5] text-pretty">Pro plus Data Imports, Log Intervention, Request Pullout, Cross-School Admin.</p>
          <p className="mt-auto text-[1.1vw] text-[#5A5A6E] leading-[1.4]">For districts running multiple schools.</p>
        </div>
      </div>
    </div>
  );
}
