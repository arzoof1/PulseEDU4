export default function CommunicationData() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">15 / 18</div>

      <div className="mt-[7vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">MODULE GROUP 04 · 5 MODULES</div>
        <h1 className="mt-[1.5vh] text-[4.5vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          Communication & Data.
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">FAMILY COMM</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">In-app messaging, email, and weekly digests — every send is logged on the student record.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ACADEMICS</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Course rosters and grade snapshots feed the Early Warning rules.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DATA IMPORTS</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Nightly CSV from your SIS keeps rosters, grades, and attendance in sync.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">PARENT PORTAL</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Read-only family view of everything above.</p>
        </div>
        <div className="col-span-2 rounded-[1.2vw] bg-[#F0DEDA] px-[2vw] py-[2.5vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">CROSS-SCHOOL ADMIN</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">District-wide grid: every school × every module on one screen, with one-click tier presets to Basic, Pro, or Enterprise.</p>
        </div>
      </div>
    </div>
  );
}
