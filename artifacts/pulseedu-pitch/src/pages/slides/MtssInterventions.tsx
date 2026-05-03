export default function MtssInterventions() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">13 / 18</div>

      <div className="mt-[7vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">MODULE GROUP 02</div>
        <h1 className="mt-[1.5vh] text-[4.5vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          MTSS & Interventions.
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">MTSS PLANS</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Tiered goals with measurable progress markers.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">LOG INTERVENTION</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Any staff member can record a session against a plan in under 30 seconds.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">REQUEST PULLOUT</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Teachers request, support staff verify, admins review.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">EARLY WARNING</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Rules-based watchlist that surfaces students before they fail.</p>
        </div>
        <div className="col-span-2 rounded-[1.2vw] bg-[#F0DEDA] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ACCOMMODATIONS</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Log every IEP/504 accommodation as it's actually used.</p>
        </div>
      </div>
    </div>
  );
}
