export default function Teachers() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[5vh]">
      <div className="absolute top-[4vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[4vh] right-[6vw] text-[1.2vw] text-[#888]">07 / 18</div>

      <div className="mt-[6vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ROLE 02 / TEACHERS</div>
        <h1 className="mt-[1vh] text-[4vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          The classroom workhorse.
        </h1>
      </div>

      <div className="mt-[4vh] grid grid-cols-3 gap-[1.5vw]">
        <div className="rounded-[1vw] bg-[#E0E7ED] px-[1.5vw] py-[2.2vh]">
          <div className="text-[0.9vw] font-bold tracking-[0.18em] text-[#5A5A6E]">PBIS POINTS</div>
          <p className="mt-[1vh] text-[1.35vw] leading-[1.35] text-pretty">Award points to a student by tapping the student card on their roster.</p>
        </div>
        <div className="rounded-[1vw] bg-[#E1EDE4] px-[1.5vw] py-[2.2vh]">
          <div className="text-[0.9vw] font-bold tracking-[0.18em] text-[#5A5A6E]">HALL PASSES</div>
          <p className="mt-[1vh] text-[1.35vw] leading-[1.35] text-pretty">Issue a hall pass by selecting the student and destination from the kiosk view.</p>
        </div>
        <div className="rounded-[1vw] bg-[#F0E4D8] px-[1.5vw] py-[2.2vh]">
          <div className="text-[0.9vw] font-bold tracking-[0.18em] text-[#5A5A6E]">TARDY PASS</div>
          <p className="mt-[1vh] text-[1.35vw] leading-[1.35] text-pretty">Mark a tardy by scanning the student's ID at the Tardy Pass kiosk.</p>
        </div>
        <div className="rounded-[1vw] bg-[#E8E0ED] px-[1.5vw] py-[2.2vh]">
          <div className="text-[0.9vw] font-bold tracking-[0.18em] text-[#5A5A6E]">FAMILY COMM</div>
          <p className="mt-[1vh] text-[1.35vw] leading-[1.35] text-pretty">Email a parent in two clicks from the student's profile — the message is logged automatically.</p>
        </div>
        <div className="rounded-[1vw] bg-[#F0DEDA] px-[1.5vw] py-[2.2vh]">
          <div className="text-[0.9vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ACCOMMODATIONS</div>
          <p className="mt-[1vh] text-[1.35vw] leading-[1.35] text-pretty">Log an accommodation use — extended time, preferential seating — by checking it off on the student card.</p>
        </div>
        <div className="rounded-[1vw] bg-[#E0E7ED] px-[1.5vw] py-[2.2vh]">
          <div className="text-[0.9vw] font-bold tracking-[0.18em] text-[#5A5A6E]">PULLOUT REQUEST</div>
          <p className="mt-[1vh] text-[1.35vw] leading-[1.35] text-pretty">Request a pullout for testing or counseling by submitting the form on the student's profile.</p>
        </div>
      </div>
    </div>
  );
}
