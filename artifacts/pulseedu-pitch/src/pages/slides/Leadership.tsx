export default function Leadership() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">06 / 18</div>

      <div className="mt-[7vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ROLE 01 / LEADERSHIP</div>
        <h1 className="mt-[1.5vh] text-[4.2vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          Admin & District Admin.
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ADMIN · STUDENT 360</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">See every student's behavior, attendance, and intervention history by clicking the student name from any list.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ADMIN · MODULE CONTROL</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Turn modules on or off for their school by opening Settings → Features.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DISTRICT ADMIN · CROSS-SCHOOL</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Compare schools on the same dashboard by switching schools from the top-right menu.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ADMIN · PULLOUT REVIEW</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Review and approve pullout requests by opening the MTSS inbox.</p>
        </div>
        <div className="col-span-2 rounded-[1.2vw] bg-[#F0DEDA] px-[2vw] py-[2.5vh]">
          <div className="text-[0.95vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ADMIN · DAILY DIGEST</div>
          <p className="mt-[1vh] text-[1.5vw] leading-[1.35] text-pretty">Get a daily digest email of new referrals, watchlist adds, and overdue interventions — automatically.</p>
        </div>
      </div>
    </div>
  );
}
