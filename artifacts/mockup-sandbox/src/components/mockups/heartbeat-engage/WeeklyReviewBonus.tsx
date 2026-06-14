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
  ShieldCheck
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
      claimed: true,
    },
    mateo: {
      name: "Mateo Rivera",
      firstName: "Mateo",
      grade: "4th Grade",
      initials: "MR",
      points: 210,
      claimed: false,
    },
  };

  const child = children[activeChild];

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
            <p className="text-sm text-slate-500">Check in anytime · Bonus once a week</p>
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
                  <h3 className="text-xl font-bold text-slate-900">You reviewed {child.firstName}'s HeartBEAT!</h3>
                  <p className="text-slate-600 text-sm max-w-[280px] mx-auto">
                    Thanks for staying in the loop. {child.firstName} has been awarded a check-in bonus.
                  </p>
                </div>

                <div className="bg-gradient-to-r from-violet-50 to-teal-50 w-full rounded-2xl p-4 border border-violet-100 flex flex-col items-center justify-center gap-2 mt-2">
                  <div className="flex items-center gap-2 text-violet-700 font-bold text-lg">
                    <Award className="h-5 w-5" />
                    +5 Bonus Points
                  </div>
                  <Badge variant="secondary" className="bg-white/60 text-slate-600 border border-slate-200">
                    <Flame className="h-3 w-3 text-orange-500 mr-1" fill="currentColor" />
                    3 weeks in a row
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
                  <h3 className="text-xl font-bold text-slate-900">HeartBEAT is ready</h3>
                  <p className="text-slate-600 text-sm max-w-[280px] mx-auto">
                    Review {child.firstName}'s attendance, behavior, and recognition to unlock this week's bonus.
                  </p>
                </div>

                <div className="w-full pt-2">
                  <Button className="w-full bg-violet-600 hover:bg-violet-700 text-white rounded-xl h-12 text-base font-semibold shadow-sm flex items-center gap-2">
                    Check in on {child.firstName}'s HeartBEAT
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
                
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 bg-slate-50 px-3 py-1.5 rounded-full">
                  <Gift className="h-3.5 w-3.5 text-violet-500" />
                  Earn +5 points for {child.firstName}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Status indicators */}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center gap-1">
              <span className="text-2xl font-bold text-slate-800">{child.claimed ? "1 of 1" : "0 of 1"}</span>
              <span className="text-xs font-medium text-slate-500">Bonus claimed this week</span>
            </div>
            <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center gap-1">
              <span className="text-lg font-bold text-slate-800">Monday</span>
              <span className="text-xs font-medium text-slate-500">Bonus limit resets</span>
            </div>
          </div>

          <p className="text-[11px] text-center text-slate-400 font-medium px-4">
            The HeartBEAT Check-In bonus (+5 pts) is set by your school administration.
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
                  This is an optional family bonus! It never affects {child.firstName}'s standing or the support our staff provides. It's just a little extra something to celebrate staying connected.
                </p>
              </div>
            </CardContent>
          </Card>
          
        </div>
      </div>
    </div>
  );
}
