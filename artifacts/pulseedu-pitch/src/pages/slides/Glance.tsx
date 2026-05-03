export default function Glance() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">03 / 18</div>

      <div className="mt-[7vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">OVERVIEW</div>
        <h1 className="mt-[1.5vh] text-[4.5vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          PulseEDU at a glance.
        </h1>
      </div>

      <div className="mt-[6vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2.5vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2.5vw] py-[3.5vh] flex items-center gap-[2vw]">
          <div className="text-[5vw] font-extrabold tracking-[-0.05em]">18</div>
          <p className="text-[1.5vw] leading-[1.35] text-pretty"><span className="font-bold">Modules</span>, one student record, one login.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2.5vw] py-[3.5vh] flex items-center gap-[2vw]">
          <div className="text-[5vw] font-extrabold tracking-[-0.05em]">14</div>
          <p className="text-[1.5vw] leading-[1.35] text-pretty"><span className="font-bold">Staff roles</span> drive what each adult sees — no clutter, no extra training.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2.5vw] py-[3.5vh] flex items-center gap-[2vw]">
          <div className="text-[5vw] font-extrabold tracking-[-0.05em]">3</div>
          <p className="text-[1.5vw] leading-[1.35] text-pretty"><span className="font-bold">Tiers</span>: Basic (4 modules), Pro (14), Enterprise (all 18).</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2.5vw] py-[3.5vh] flex items-center gap-[2vw]">
          <div className="text-[5vw] font-extrabold tracking-[-0.05em]">∞</div>
          <p className="text-[1.5vw] leading-[1.35] text-pretty"><span className="font-bold">Multi-school, multi-district</span> from day one.</p>
        </div>
      </div>
    </div>
  );
}
