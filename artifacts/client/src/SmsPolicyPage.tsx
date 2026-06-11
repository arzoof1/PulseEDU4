// Public, unauthenticated SMS opt-in disclosure and policy page.
// Required for AWS SNS toll-free / 10DLC registration review — reviewers
// must be able to open this URL without signing in.
// Mounted at /sms-policy by main.tsx.

const APP_ROOT = import.meta.env.BASE_URL || "/";

const sectionTitle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  marginTop: "1.25rem",
  marginBottom: "0.35rem",
  color: "#e2e8f0",
};

const bodyText: React.CSSProperties = {
  fontSize: "0.9rem",
  lineHeight: 1.65,
  opacity: 0.88,
  margin: 0,
};

const listStyle: React.CSSProperties = {
  ...bodyText,
  margin: "0.35rem 0 0",
  paddingLeft: "1.25rem",
};

const optInBox: React.CSSProperties = {
  background: "rgba(15,23,42,0.55)",
  border: "1px solid rgba(59,130,246,0.35)",
  borderRadius: 8,
  padding: "0.85rem 1rem",
  marginTop: "0.5rem",
  fontSize: "0.88rem",
  lineHeight: 1.6,
  color: "#dbeafe",
};

export default function SmsPolicyPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem 1.25rem 3rem",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <header style={{ textAlign: "center", marginBottom: "1.75rem" }}>
          <div
            style={{
              fontSize: "1.6rem",
              fontWeight: 700,
              letterSpacing: "0.02em",
            }}
          >
            Pulse<span style={{ color: "#3b82f6" }}>EDU</span>
          </div>
          <h1
            style={{
              fontSize: "1.15rem",
              fontWeight: 600,
              margin: "0.5rem 0 0",
              opacity: 0.9,
            }}
          >
            SMS Text Message Policy &amp; Opt-In
          </h1>
          <p style={{ ...bodyText, marginTop: "0.5rem", opacity: 0.65 }}>
            A Pulse Kinetics product for K–12 schools and districts
          </p>
        </header>

        <main
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 12,
            padding: "1.5rem 1.35rem 1.75rem",
          }}
        >
          <p style={bodyText}>
            PulseEDU may send automated text messages to parents, guardians,
            and school staff on behalf of participating schools. This page
            describes what messages are sent, how you opt in, and how you can
            opt out. Message delivery is provided through Amazon Web Services
            (AWS) Simple Notification Service (SNS).
          </p>

          <h2 style={sectionTitle}>Who sends the messages?</h2>
          <p style={bodyText}>
            Messages are sent by your <strong>school or school district</strong>{" "}
            through the PulseEDU platform (operated by Pulse Kinetics). The
            sender name shown on your phone may be a school name, district
            name, or a toll-free number assigned to your school&apos;s PulseEDU
            account.
          </p>

          <h2 style={sectionTitle}>Types of messages</h2>
          <p style={bodyText}>
            PulseEDU sends <strong>informational and operational</strong> school
            messages only — not marketing or promotional texts. Examples include:
          </p>
          <ul style={listStyle}>
            <li>
              <strong>Staff operational alerts</strong> — e.g. a new school tour
              or enrollment lead submitted on the public tour request form.
            </li>
            <li>
              <strong>Parent / guardian updates</strong> — e.g. notification
              when a student returns to class from a behavioral or academic
              pullout, and other school-related updates your district enables.
            </li>
            <li>
              <strong>School event notifications</strong> — transactional
              messages related to events your school manages through PulseEDU
              (such as ticket delivery), when SMS is enabled.
            </li>
          </ul>
          <p style={{ ...bodyText, marginTop: "0.75rem" }}>
            Message frequency varies depending on school activity. Most
            recipients receive only occasional messages; staff on operational
            alert lists may receive more frequent notifications during busy
            enrollment periods.
          </p>

          <h2 style={sectionTitle}>How to opt in</h2>
          <p style={bodyText}>
            You must give explicit consent before we send you SMS messages.
            Consent is collected in one of the following ways:
          </p>
          <ul style={listStyle}>
            <li>
              <strong>Parents and guardians</strong> — by providing a mobile
              phone number on your school&apos;s enrollment or registration
              forms, student information update forms, or district roster
              records <em>and</em> agreeing to receive text messages using the
              language below (or equivalent language approved by your district).
              Phone numbers imported from your student information system are
              used for SMS only when your district has documented SMS consent on
              file.
            </li>
            <li>
              <strong>School staff</strong> — by providing a personal mobile
              number in the PulseEDU staff directory (or to your school
              administrator) and agreeing to receive operational text alerts
              related to your job duties, using the staff opt-in language below.
            </li>
            <li>
              <strong>Families using public school tour forms</strong> — SMS is
              not sent to tour requesters unless they separately opt in on a
              form that includes the consent language below. Tour-request phone
              numbers are used for school follow-up calls and emails unless SMS
              consent is explicitly collected.
            </li>
          </ul>

          <h2 style={sectionTitle}>Parent / guardian opt-in language</h2>
          <p style={bodyText}>
            The following is the consent language shown (or equivalent) when a
            parent or guardian provides a mobile number for school text
            messages:
          </p>
          <div style={optInBox}>
            By providing my mobile phone number and agreeing to receive text
            messages, I consent to receive automated SMS notifications from my
            child&apos;s school and school district through PulseEDU regarding
            school-related updates (including attendance, behavior,
            interventions, pullouts, events, and other educational notices).
            Message frequency varies. Message and data rates may apply. Reply{" "}
            <strong>STOP</strong> to opt out at any time. Reply <strong>HELP</strong>{" "}
            for help. Consent to receive text messages is not required as a
            condition of enrollment or receiving educational services.
          </div>

          <h2 style={sectionTitle}>Staff opt-in language</h2>
          <p style={bodyText}>
            The following is the consent language for school employees who
            receive operational SMS alerts:
          </p>
          <div style={optInBox}>
            By providing my mobile phone number as a school employee, I agree
            to receive operational text message alerts from my school through
            PulseEDU related to my job duties (such as new enrollment tour
            requests and other time-sensitive school operations). Message
            frequency varies. Message and data rates may apply. Reply{" "}
            <strong>STOP</strong> to opt out. Reply <strong>HELP</strong> for
            help.
          </div>

          <h2 style={sectionTitle}>How to opt out</h2>
          <p style={bodyText}>
            You can stop receiving SMS messages at any time:
          </p>
          <ul style={listStyle}>
            <li>
              Reply <strong>STOP</strong> to any message sent through PulseEDU.
              You will receive a one-time confirmation that you have been
              unsubscribed.
            </li>
            <li>
              Reply <strong>HELP</strong> for assistance or contact your school
              office to update your communication preferences or remove your
              mobile number from school records.
            </li>
            <li>
              Parents may also manage email and portal notification preferences
              in the PulseEDU Parent Portal when those features are enabled by
              your school.
            </li>
          </ul>

          <h2 style={sectionTitle}>Message and data rates</h2>
          <p style={bodyText}>
            Standard message and data rates from your mobile carrier may apply.
            PulseEDU and participating schools do not charge recipients for SMS
            messages, but your wireless plan may charge for incoming texts.
          </p>

          <h2 style={sectionTitle}>Privacy</h2>
          <p style={bodyText}>
            Mobile phone numbers are used only to deliver school-related
            messages authorized by your district. Numbers are stored securely
            as part of your school&apos;s PulseEDU tenant data and are not sold
            to third parties for marketing. Message content is limited to
            information your school chooses to share through PulseEDU. For
            questions about how your school handles student and family data,
            contact your school district directly.
          </p>

          <h2 style={sectionTitle}>Support</h2>
          <p style={bodyText}>
            For help with text messages from your school, contact your school
            office first. For platform questions, visit{" "}
            <a
              href="https://pulsekinetics.us"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#93c5fd" }}
            >
              pulsekinetics.us
            </a>
            .
          </p>

          <p
            style={{
              ...bodyText,
              marginTop: "1.5rem",
              fontSize: "0.8rem",
              opacity: 0.55,
            }}
          >
            Last updated: June 2026
          </p>
        </main>

        <div style={{ textAlign: "center", marginTop: "1.5rem" }}>
          <a
            href={APP_ROOT}
            style={{
              color: "#93c5fd",
              fontSize: "0.9rem",
              textDecoration: "none",
            }}
          >
            ← Back to staff sign-in
          </a>
        </div>
      </div>
    </div>
  );
}
