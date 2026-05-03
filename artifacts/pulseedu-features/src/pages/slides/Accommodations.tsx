export default function Accommodations() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-[#0C0F1A] text-white font-[Inter,sans-serif]">
      <div className="absolute -top-[20vh] -right-[10vw] w-[50vw] h-[50vw] rounded-full bg-[#4F7FFF] opacity-[0.05] blur-[8vw]" />
      <div className="absolute -bottom-[30vh] -left-[15vw] w-[60vw] h-[60vw] rounded-full bg-[#7C6BF0] opacity-[0.05] blur-[10vw]" />
      <div className="absolute inset-0 opacity-50 pointer-events-none" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)", backgroundSize: "4vw 4vw" }} />

      <div className="absolute top-[5vh] left-[5vw] flex items-center gap-[1vw]">
        <div className="w-[2vw] h-[2vw] rounded-[0.4vw] bg-[#4F7FFF]" />
        <div className="text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      </div>
      <div className="absolute top-[5vh] right-[5vw] flex items-center gap-[1vw]">
        <div className="px-[1vw] py-[0.5vh] bg-[#4F7FFF]/15 border border-[#4F7FFF]/40 rounded-full text-[0.85vw] font-semibold tracking-widest uppercase text-[#4F7FFF]">Pro</div>
        <div className="text-[1vw] text-white/50">16 / 20</div>
      </div>

      <div className="relative z-10 h-full grid grid-cols-2 gap-[3vw] px-[7vw] py-[14vh] items-center">
        <div>
          <div className="text-[1vw] font-medium tracking-widest text-[#4F7FFF] uppercase mb-[1.5vh]">Module 14 · Student support</div>
          <h1 className="text-[5vw] font-extrabold leading-[1] tracking-[-0.03em] mb-[3vh]">Accommodations</h1>
          <p className="text-[1.5vw] font-light text-white/70 leading-[1.5] max-w-[35vw]">Log every IEP and 504 accommodation as it actually gets used — visible to the right staff, hidden from everyone else.</p>
        </div>
        <div className="flex flex-col gap-[2vh]">
          <div className="bg-[#131726] border border-white/10 rounded-[1vw] p-[2vw]">
            <div className="text-[0.85vw] font-semibold tracking-widest text-[#4F7FFF] uppercase mb-[1vh]">What it does</div>
            <div className="text-[1.1vw] text-white/80 leading-[1.55]">Records each accommodation provided in a session — extended time, preferential seating, sensory break — against the student's plan.</div>
          </div>
          <div className="bg-[#131726] border border-white/10 rounded-[1vw] p-[2vw]">
            <div className="text-[0.85vw] font-semibold tracking-widest text-[#4F7FFF] uppercase mb-[1vh]">Who uses it</div>
            <div className="text-[1.1vw] text-white/80 leading-[1.55]">Special-education case managers · Classroom teachers · Counselors · Admin · Hidden from staff without a need-to-know role</div>
          </div>
          <div className="bg-[#131726] border border-white/10 rounded-[1vw] p-[2vw]">
            <div className="text-[0.85vw] font-semibold tracking-widest text-[#4F7FFF] uppercase mb-[1vh]">How it works</div>
            <div className="text-[1.1vw] text-white/80 leading-[1.55]">Library of accommodations attached to each plan · One-tap log per session · Audit-ready report by student or by staff · Role-gated visibility</div>
          </div>
        </div>
      </div>
    </div>
  );
}
