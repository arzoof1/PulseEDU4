export default function LeadershipInsights() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        07 · Leadership Intelligence
      </div>

      <div className="mt-[8vh]">
        <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
          Insights Dashboards
        </div>
        <h1 className="mt-[1.2vh] font-display text-[3vw] font-bold leading-[1.1] tracking-[-0.03em] max-w-[70vw] text-balance">
          Data should not simply tell us what happened. It should guide what we do next.
        </h1>
      </div>

      <div className="mt-[4.5vh] grid grid-cols-3 gap-[1.6vw]">
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.8vw] py-[2.4vh]">
          <div className="font-display text-[2vw] font-bold">Engagement</div>
          <p className="mt-[1vh] font-body text-[1.6vw] leading-[1.25] text-[#5B6B79]">Attendance and participation trends across the school.</p>
        </div>
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.8vw] py-[2.4vh]">
          <div className="font-display text-[2vw] font-bold">Behavior</div>
          <p className="mt-[1vh] font-body text-[1.6vw] leading-[1.25] text-[#5B6B79]">PBIS and referrals, by grade and by window.</p>
        </div>
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.8vw] py-[2.4vh]">
          <div className="font-display text-[2vw] font-bold">Academics</div>
          <p className="mt-[1vh] font-body text-[1.6vw] leading-[1.25] text-[#5B6B79]">FAST performance and learning gains over time.</p>
        </div>
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.8vw] py-[2.4vh]">
          <div className="font-display text-[2vw] font-bold">SEB / SEL</div>
          <p className="mt-[1vh] font-body text-[1.6vw] leading-[1.25] text-[#5B6B79]">Social-emotional signals brought into one view.</p>
        </div>
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.8vw] py-[2.4vh]">
          <div className="font-display text-[2vw] font-bold">Equity</div>
          <p className="mt-[1vh] font-body text-[1.6vw] leading-[1.25] text-[#5B6B79]">Disaggregation that surfaces gaps, not averages.</p>
        </div>
        <div className="rounded-[0.9vw] bg-[#0B1F33] text-[#EAF2F0] px-[1.8vw] py-[2.4vh]">
          <div className="font-display text-[2vw] font-bold text-[#2DD4BF]">Early Warning</div>
          <p className="mt-[1vh] font-body text-[1.6vw] leading-[1.25] text-[#C7D6DE]">At-risk students flagged, with drill-down to a profile.</p>
        </div>
      </div>

      <div className="mt-[4vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
        <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Live demo</span>
        <span className="font-body text-[1.5vw] text-[#EAF2F0]">Drill from a school-wide trend down to a single student profile</span>
      </div>
    </div>
  );
}
