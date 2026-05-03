export default function Cover() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-[#0C0F1A] text-white font-[Inter,sans-serif]">
      <div className="absolute -top-[20vh] -right-[10vw] w-[50vw] h-[50vw] rounded-full bg-[#4F7FFF] opacity-[0.05] blur-[8vw]" />
      <div className="absolute -bottom-[30vh] -left-[15vw] w-[60vw] h-[60vw] rounded-full bg-[#7C6BF0] opacity-[0.05] blur-[10vw]" />
      <div
        className="absolute inset-0 opacity-50 pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "4vw 4vw",
        }}
      />

      <div className="absolute top-[5vh] left-[5vw] flex items-center gap-[1vw]">
        <div className="w-[2vw] h-[2vw] rounded-[0.4vw] bg-[#4F7FFF]" />
        <div className="text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      </div>
      <div className="absolute top-[5vh] right-[5vw] text-[1vw] text-white/50">2026</div>

      <div className="relative z-10 h-full flex flex-col justify-center items-center text-center px-[15vw]">
        <div className="inline-flex items-center px-[1.2vw] py-[0.6vh] bg-[#7C6BF0]/15 border border-[#7C6BF0]/30 rounded-[2vw] text-[#7C6BF0] text-[1vw] font-medium tracking-wider mb-[4vh] uppercase">
          Feature Catalog · v1
        </div>
        <h1 className="text-[6vw] font-extrabold leading-[1.05] tracking-[-0.03em] mb-[2vh]">
          Every feature,<span className="text-[#4F7FFF]"> spelled out.</span>
        </h1>
        <p className="text-[1.6vw] font-light text-white/70 leading-[1.5] max-w-[55vw] mb-[6vh]">
          A reference for every module in PulseEDU — what it does, who uses it, and how it works in a school day.
        </p>
        <div className="flex gap-[1.5vw] opacity-90">
          <div className="px-[1.5vw] py-[1vh] bg-white/5 border border-white/10 rounded-[0.5vw] text-[1vw] text-white/80">18 modules</div>
          <div className="px-[1.5vw] py-[1vh] bg-white/5 border border-white/10 rounded-[0.5vw] text-[1vw] text-white/80">3 pricing tiers</div>
          <div className="px-[1.5vw] py-[1vh] bg-white/5 border border-white/10 rounded-[0.5vw] text-[1vw] text-white/80">14 staff role flags</div>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-[0.85vw] text-white/40 tracking-widest uppercase">
        PulseEDU · Confidential
      </div>
    </div>
  );
}
