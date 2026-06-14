import React, { useState } from "react";
import {
  Heart,
  Award,
  ChevronDown,
  CheckCircle2,
  Flame,
  Info,
  Gift,
  ArrowRight,
  ShieldCheck,
  CalendarCheck,
  Lock,
  Check,
  Circle
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const EkgDivider = () => (
  <div className="flex items-center justify-center my-6 opacity-20">
    <div className="h-px bg-red-500 w-full flex-1" />
    <svg
      width="120"
      height="24"
      viewBox="0 0 120 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-red-500 mx-4"
    >
      <path
        d="M0 12H30L35 4L45 20L50 12H70L75 8L85 16L90 12H120"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
    <div className="h-px bg-red-500 w-full flex-1" />
  </div>
);

export function WeeklyReviewBonus() {
  const [activeChild, setActiveChild] = useState<"amelia" | "mateo">("amelia");

  const children = {
    amelia: {
      name: "Amelia Rivera",
      firstName: "Amelia",
      grade: "7th Grade",
      initials: "AR",
      points: 451,
      claimed: false,
      sectionsViewed: 2,
      streakDays: 0,
      weekEarned: 2,
      weekMax: 5,
    },
    mateo: {
      name: "Mateo Rivera",
      firstName: "Mateo",
      grade: "4th Grade",
      initials: "MR",
      points: 210,
      claimed: true,
      sectionsViewed: 3,
      streakDays: 3,
      weekEarned: 4,
      weekMax: 5,
    },
  };

  const child = children[activeChild];

  const sections = [
    { label: "Attendance", icon: CalendarCheck },
    { label: "Behavior & PBIS", icon: Heart },
    { label: "Recognition & Notes", icon: Award },
  ];

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 sm:p-8 font-sans">
      {/* Mobile App Container */}
      <div className="w-full max-w-[430px] bg-slate-50 min-h-[850px] rounded-[40px] shadow-2xl overflow-hidden relative flex flex-col ring-8 ring-slate-800">
        
        {/* Brand Gradient Band */}
        <div className="h-1.5 w-full bg-gradient-to-r from-violet-600 via-teal-600 to-green-600 shrink-0" />

        {/* Header / Sibling Switcher */}
        <div className="px-6 pt-6 pb-4 bg-white border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12 border-2 border-slate-50 shadow-sm ring-1 ring-slate-100">
              <AvatarFallback className="bg-gradient-to-br from-violet-100 to-teal-100 text-violet-700 font-bold">
                {child.initials}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-0.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
                    <h1 className="text-lg font-bold text-slate-900 tracking-tight leading-none">
                      {child.name}
                    </h1>
                    <ChevronDown className="h-4 w-4 text-slate-400" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56 rounded-2xl">
                  <DropdownMenuItem 
                    className={`font-medium py-3 cursor-pointer ${activeChild === 'amelia' ? 'bg-slate-50' : ''}`}
                    onClick={() => setActiveChild('amelia')}
                  >
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6"><AvatarFallback className="text-[10px]">AR</AvatarFallback></Avatar>
                      <span>Amelia Rivera (7th)</span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem 
                    className={`font-medium py-3 cursor-pointer ${activeChild === 'mateo' ? 'bg-slate-50' : ''}`}
                    onClick={() => setActiveChild('mateo')}
                  >
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6"><AvatarFallback className="text-[10px]">MR</AvatarFallback></Avatar>
                      <span>Mateo Rivera (4th)</span>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="text-sm text-slate-500 font-medium">
                {child.grade} · {child.points} PBIS Points
              </p>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          <div className="text-center space-y-1 mt-2 mb-6">
            <h2 className="text-xl font-bold text-slate-900">HeartBEAT Check-In</h2>
            <p className="text-sm text-slate-500">Check in daily · Earn a small bonus</p>
          </div>

          {/* Hero Card */}
          {child.claimed ? (
            <Card className="border-slate-100 rounded-3xl shadow-sm overflow-hidden bg-white relative">
              <div className="absolute top-0 right-0 w-32 h-32 bg-green-500/10 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none" />
              <div className="absolute bottom-0 left-0 w-32 h-32 bg-violet-500/10 rounded-full blur-2xl -ml-10 -mb-10 pointer-events-none" />
              
              <CardContent className="p-6 relative z-10 flex flex-col items-center text-center space-y-4">
                <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center mb-2 shadow-inner">
                  <CheckCircle2 className="h-8 w-8 text-green-600" />
                </div>
                
                <div className="space-y-1.5">
                  <h3 className="text-xl font-bold text-slate-900">You reviewed {child.firstName}'s HeartBEAT today!</h3>
                  <p className="text-slate-600 text-sm max-w-[280px] mx-auto">
                    All 3 sections viewed. {child.firstName} earned today's check-in bonus — come back tomorrow for another.
                  </p>
                </div>

                <div className="bg-gradient-to-r from-violet-50 to-teal-50 w-full rounded-2xl p-4 border border-violet-100 flex flex-col items-center justify-center gap-2 mt-2">
                  <div className="flex items-center gap-2 text-violet-700 font-bold text-lg">
                    <Award className="h-5 w-5" />
                    +1 Bonus Point
                  </div>
                  <Badge variant="secondary" className="bg-white/60 text-slate-600 border border-slate-200">
                    <Flame className="h-3 w-3 text-orange-500 mr-1" fill="currentColor" />
                    {child.streakDays}-day streak
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-slate-100 rounded-3xl shadow-sm overflow-hidden bg-white relative border-2 border-violet-100">
              <div className="absolute top-0 right-0 w-32 h-32 bg-violet-500/10 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none" />
              
              <CardContent className="p-6 relative z-10 flex flex-col items-center text-center space-y-5">
                <div className="h-16 w-16 rounded-full bg-violet-100 flex items-center justify-center mb-1">
                  <Heart className="h-8 w-8 text-violet-600" />
                </div>
                
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-slate-900">Today's check-in</h3>
                  <p className="text-slate-600 text-sm max-w-[280px] mx-auto">
                    View all 3 parts of {child.firstName}'s HeartBEAT to earn today's bonus.
                  </p>
                </div>

                <div className="w-full space-y-2 text-left">
                  {sections.map((s, i) => {
                    const done = i < child.sectionsViewed;
                    const Icon = s.icon;
                    return (
                      <div
                        key={s.label}
                        className={`flex items-center gap-3 rounded-2xl border p-3 ${done ? "border-green-100 bg-green-50" : "border-slate-100 bg-slate-50"}`}
                      >
                        <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${done ? "bg-green-100" : "bg-white border border-slate-200"}`}>
                          <Icon className={`h-4 w-4 ${done ? "text-green-600" : "text-slate-400"}`} />
                        </div>
                        <span className={`flex-1 text-sm font-semibold ${done ? "text-slate-800" : "text-slate-500"}`}>
                          {s.label}
                        </span>
                        {done ? (
                          <Check className="h-5 w-5 text-green-600" />
                        ) : (
                          <Circle className="h-5 w-5 text-slate-300" />
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="w-full pt-1">
                  <Button
                    disabled={child.sectionsViewed < 3}
                    className="w-full bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl h-12 text-base font-semibold shadow-sm flex items-center gap-2"
                  >
                    {child.sectionsViewed < 3 ? (
                      <>
                        <Lock className="h-4 w-4" />
                        View all sections to unlock
                      </>
                    ) : (
                      <>
                        Claim {child.firstName}'s +1 bonus
                        <ArrowRight className="h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
                
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 bg-slate-50 px-3 py-1.5 rounded-full">
                  <Gift className="h-3.5 w-3.5 text-violet-500" />
                  {child.sectionsViewed} of 3 sections viewed
                </div>
              </CardContent>
            </Card>
          )}

          {/* Status indicators */}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center gap-1">
              <span className="text-2xl font-bold text-slate-800">+{child.weekEarned} <span className="text-base text-slate-400">/ +{child.weekMax}</span></span>
              <span className="text-xs font-medium text-slate-500">Earned this week (max +{child.weekMax})</span>
            </div>
            <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center gap-1">
              <span className="text-lg font-bold text-slate-800">1 / day</span>
              <span className="text-xs font-medium text-slate-500">Bonus opportunities</span>
            </div>
          </div>

          <p className="text-[11px] text-center text-slate-400 font-medium px-4">
            One small bonus per day (max +{child.weekMax} per week), set by your school. Viewing all sections keeps each check-in meaningful.
          </p>

          <EkgDivider />

          {/* Equity-safe note */}
          <Card className="border-slate-100 rounded-2xl bg-white shadow-sm overflow-hidden">
            <CardContent className="p-5 flex gap-4">
              <div className="mt-0.5 shrink-0">
                <div className="h-8 w-8 rounded-full bg-slate-100 flex items-center justify-center">
                  <ShieldCheck className="h-4 w-4 text-slate-600" />
                </div>
              </div>
              <div className="space-y-1.5 text-sm">
                <h4 className="font-bold text-slate-900">About this bonus</h4>
                <p className="text-slate-600 leading-relaxed">
                  Optional and capped — one small bonus a day, up to +{child.weekMax} a week, so no family can get ahead by spending more time. It never affects {child.firstName}'s standing or the support our staff provides.
                </p>
              </div>
            </CardContent>
          </Card>
          
        </div>
      </div>
    </div>
  );
}
