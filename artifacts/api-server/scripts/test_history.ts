import { loadFastHistory, priorSchoolYearLabels } from "../src/lib/fastHistory.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../src/lib/schoolYear.js";
const current = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
console.log("current SY:", current);
console.log("wanted prior years:", priorSchoolYearLabels(current, 3));
const map = await loadFastHistory({
  schoolId: 1,
  studentIds: ["FL000011574961","FL000007068973","FL000005676719","FL000007385324"],
  subjects: ["ela","math"],
});
console.log("map size:", map.size);
for (const [sid, bySubj] of map) {
  for (const [subj, arr] of bySubj) console.log(sid, subj, JSON.stringify(arr));
}
process.exit(0);
