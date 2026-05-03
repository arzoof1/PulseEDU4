export default function Tiers() {
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
      <div className="absolute top-[5vh] right-[5vw] text-[1vw] text-white/50">02 / 20</div>

      <div className="relative z-10 h-full flex flex-col justify-center px-[7vw]">
        <div className="text-[1vw] font-medium tracking-widest text-[#7C6BF0] uppercase mb-[1.5vh]">Pricing tiers</div>
        <h1 className="text-[4.2vw] font-extrabold leading-[1.05] tracking-[-0.03em] mb-[2vh]">Three tiers, one app.</h1>
        <p className="text-[1.4vw] font-light text-white/70 max-w-[60vw] mb-[5vh]">
          Schools start on Basic, add Pro for the full operations stack, and move to Enterprise for SIS integration and district-wide controls.
        </p>

        <div className="grid grid-cols-3 gap-[2vw]">
          <div className="bg-[#131726] border border-white/10 rounded-[1vw] p-[2.5vw]">
            <div className="text-[1vw] font-semibold tracking-widest text-white/60 uppercase mb-[1vh]">Basic</div>
            <div className="text-[3vw] font-extrabold leading-none mb-[1vh]">4</div>
            <div className="text-[1.1vw] text-white/70 mb-[3vh]">modules · core daily operations</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">PBIS Points & Store</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Hall Passes</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Tardy Pass</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Family Comm</div>
          </div>

          <div className="bg-[#131726] border border-[#4F7FFF]/40 rounded-[1vw] p-[2.5vw] relative">
            <div className="absolute -top-[1.4vh] left-[2.5vw] px-[0.8vw] py-[0.4vh] bg-[#4F7FFF] text-white text-[0.8vw] font-semibold tracking-wider rounded-full uppercase">Most popular</div>
            <div className="text-[1vw] font-semibold tracking-widest text-[#4F7FFF] uppercase mb-[1vh]">Pro</div>
            <div className="text-[3vw] font-extrabold leading-none mb-[1vh]">+10</div>
            <div className="text-[1.1vw] text-white/70 mb-[3vh]">modules · MTSS, displays, parent portal</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">MTSS · Behavior Specialist</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">ISS · Displays · Bell Schedule</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Early Warning · Academics</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Houses · Parent Portal · Accommodations</div>
          </div>

          <div className="bg-[#131726] border border-[#7C6BF0]/40 rounded-[1vw] p-[2.5vw]">
            <div className="text-[1vw] font-semibold tracking-widest text-[#7C6BF0] uppercase mb-[1vh]">Enterprise</div>
            <div className="text-[3vw] font-extrabold leading-none mb-[1vh]">+4</div>
            <div className="text-[1.1vw] text-white/70 mb-[3vh]">modules · SIS data + cross-school</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Data Imports</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Log Intervention</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Request Pullout</div>
            <div className="text-[1vw] text-white/80 leading-[1.6]">Cross-School Admin</div>
          </div>
        </div>
      </div>
    </div>
  );
}
