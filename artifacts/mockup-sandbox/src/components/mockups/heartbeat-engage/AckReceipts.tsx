import React, { useState } from "react";
import { 
  Heart, 
  Award, 
  Clock, 
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  FileText,
  Info,
  Check,
  Eye
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
    <svg width="60" height="16" viewBox="0 0 120 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-red-500 mx-3">
      <path d="M0 12H30L35 4L45 20L50 12H70L75 8L85 16L90 12H120" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
    <div className="h-px bg-red-500 w-full flex-1" />
  </div>
);

export function AckReceipts() {
  const [acked, setAcked] = useState<Record<string, boolean>>({
    'msg-4': true // General announcement already acked
  });

  const handleAck = (id: string) => {
    setAcked(prev => ({ ...prev, [id]: true }));
  };

  return (
    <div className="min-h-screen bg-slate-900 flex justify-center py-8">
      <div className="w-full max-w-[430px] bg-slate-50 min-h-[800px] shadow-2xl relative flex flex-col sm:rounded-[2.5rem] overflow-hidden">
        {/* Brand Gradient Band */}
        <div className="h-1.5 w-full shrink-0 bg-gradient-to-r from-violet-600 via-teal-600 to-green-600" />
        
        {/* Content Column */}
        <main className="flex-1 overflow-y-auto hide-scrollbar pb-12">
          
          {/* Header & Sibling Switcher */}
          <div className="bg-white px-5 pt-6 pb-5 shadow-sm border-b border-slate-100 z-10 relative">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12 border-2 border-slate-50 shadow-sm ring-1 ring-slate-100">
                  <AvatarFallback className="bg-gradient-to-br from-violet-100 to-teal-100 text-violet-700 font-bold">
                    AR
                  </AvatarFallback>
                </Avatar>
                <div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
                        <h1 className="text-lg font-bold text-slate-900 tracking-tight">Amelia Rivera</h1>
                        <ChevronDown className="h-4 w-4 text-slate-400" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48 rounded-xl border-slate-100 shadow-lg">
                      <DropdownMenuItem className="font-medium bg-slate-50/80 cursor-pointer p-3">
                        <Avatar className="h-6 w-6 mr-2">
                          <AvatarFallback className="bg-violet-100 text-violet-700 text-[10px]">AR</AvatarFallback>
                        </Avatar>
                        Amelia Rivera (7th)
                      </DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer p-3">
                        <Avatar className="h-6 w-6 mr-2">
                          <AvatarFallback className="bg-teal-100 text-teal-700 text-[10px]">MR</AvatarFallback>
                        </Avatar>
                        Mateo Rivera (4th)
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <p className="text-xs text-slate-500 font-medium">Phoenix House • 451 pts</p>
                </div>
              </div>
            </div>
          </div>

          <div className="px-4 pt-5 pb-8 space-y-4">
            
            <div className="flex items-center justify-between px-1">
              <h2 className="text-base font-bold text-slate-900">Action Required</h2>
              <Badge variant="secondary" className="bg-violet-100 text-violet-700 hover:bg-violet-100 rounded-full font-bold">
                {Object.values(acked).filter(v => !v).length > 0 ? `${4 - Object.values(acked).length} New` : 'All caught up!'}
              </Badge>
            </div>

            {/* Message 1: Field Trip */}
            <Card className="rounded-[1.5rem] border-slate-100 shadow-sm overflow-hidden">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                      <FileText className="h-4 w-4 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-900">Field Trip Permission</p>
                      <p className="text-[11px] text-slate-500 font-medium">Front Office • Today, 9:00 AM</p>
                    </div>
                  </div>
                </div>
                
                <p className="text-sm text-slate-700 leading-relaxed pl-10">
                  Please review and acknowledge the permission slip for the upcoming 7th Grade Science Museum trip on May 12th.
                </p>
                
                <div className="pl-10 pt-2">
                  {!acked['msg-1'] ? (
                    <Button 
                      onClick={() => handleAck('msg-1')}
                      className="w-full bg-violet-600 hover:bg-violet-700 text-white rounded-xl shadow-sm"
                    >
                      <Check className="w-4 h-4 mr-2" /> Got it
                    </Button>
                  ) : (
                    <div className="bg-green-50 rounded-xl p-3 flex flex-col gap-2 border border-green-100">
                      <div className="flex items-center gap-2 text-green-700 text-sm font-semibold">
                        <CheckCircle2 className="w-4 h-4" />
                        Acknowledged by Maria Rivera
                      </div>
                      <div className="text-xs text-green-600/80 pl-6">Apr 28, 10:42 AM</div>
                      <div className="ml-6 mt-1 flex items-center gap-1.5 text-xs font-bold text-violet-600 bg-white self-start px-2 py-1 rounded-md border border-green-100 shadow-sm">
                        <Award className="w-3.5 h-3.5" /> Amelia earned +2 bonus points
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>

              {/* Staff Context Panel - Attached directly to the relevant card */}
              <div className="bg-slate-800 text-slate-200 p-4 border-t border-slate-700/50">
                <div className="flex items-center gap-2 mb-3">
                  <Eye className="w-4 h-4 text-slate-400" />
                  <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">What staff sees</p>
                </div>
                <div className="bg-slate-900/50 rounded-xl p-3 border border-slate-700">
                  <div className="flex justify-between items-end mb-2">
                    <p className="text-sm font-medium text-white">Seen by 38 of 52 families</p>
                    <p className="text-xs text-slate-400">14 not yet seen</p>
                  </div>
                  <Progress value={73} className="h-1.5 bg-slate-700 [&>div]:bg-teal-500" />
                </div>
              </div>
            </Card>

            {/* Message 2: PBIS/Behavior */}
            <Card className="rounded-[1.5rem] border-slate-100 shadow-sm overflow-hidden">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-violet-100 flex items-center justify-center shrink-0">
                      <Heart className="h-4 w-4 text-violet-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-900">Positive Behavior Note</p>
                      <p className="text-[11px] text-slate-500 font-medium">Mr. Davis • Yesterday, 2:15 PM</p>
                    </div>
                  </div>
                </div>
                
                <p className="text-sm text-slate-700 leading-relaxed pl-10">
                  Amelia went out of her way to help a new student navigate to their next class today. Great leadership!
                </p>
                
                <div className="pl-10 pt-2">
                  {!acked['msg-2'] ? (
                    <Button 
                      onClick={() => handleAck('msg-2')}
                      className="w-full bg-violet-600 hover:bg-violet-700 text-white rounded-xl shadow-sm"
                    >
                      <Check className="w-4 h-4 mr-2" /> Got it
                    </Button>
                  ) : (
                    <div className="bg-green-50 rounded-xl p-3 flex flex-col gap-2 border border-green-100">
                      <div className="flex items-center gap-2 text-green-700 text-sm font-semibold">
                        <CheckCircle2 className="w-4 h-4" />
                        Acknowledged by Maria Rivera
                      </div>
                      <div className="text-xs text-green-600/80 pl-6">Apr 28, 10:42 AM</div>
                      <div className="ml-6 mt-1 flex items-center gap-1.5 text-xs font-bold text-violet-600 bg-white self-start px-2 py-1 rounded-md border border-green-100 shadow-sm">
                        <Award className="w-3.5 h-3.5" /> Amelia earned +2 bonus points
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Message 3: Attendance Update */}
            <Card className="rounded-[1.5rem] border-slate-100 shadow-sm overflow-hidden">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                      <AlertCircle className="h-4 w-4 text-amber-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-900">Attendance Update</p>
                      <p className="text-[11px] text-slate-500 font-medium">Auto-Alert • Apr 26, 8:30 AM</p>
                    </div>
                  </div>
                </div>
                
                <p className="text-sm text-slate-700 leading-relaxed pl-10">
                  Heads up: Amelia has accumulated 3 tardies to 1st period this month. We wanted to keep you informed.
                </p>
                
                <div className="pl-10 pt-2">
                  {!acked['msg-3'] ? (
                    <Button 
                      onClick={() => handleAck('msg-3')}
                      className="w-full bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl shadow-sm font-semibold"
                    >
                      <Check className="w-4 h-4 mr-2" /> Mark as seen
                    </Button>
                  ) : (
                    <div className="bg-green-50 rounded-xl p-3 flex flex-col gap-1 border border-green-100">
                      <div className="flex items-center gap-2 text-green-700 text-sm font-semibold">
                        <CheckCircle2 className="w-4 h-4" />
                        Acknowledged by Maria Rivera
                      </div>
                      <div className="text-xs text-green-600/80 pl-6">Apr 28, 10:42 AM</div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <EkgDivider />

            <h2 className="text-base font-bold text-slate-900 px-1 pt-2">Past Acknowledgements</h2>

            {/* Message 4: General Announcement (Already Acked) */}
            <Card className="rounded-[1.5rem] border-slate-100 shadow-sm overflow-hidden opacity-75 hover:opacity-100 transition-opacity bg-slate-50/50">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-slate-200 flex items-center justify-center shrink-0">
                      <Info className="h-4 w-4 text-slate-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-900">Spring Concert Details</p>
                      <p className="text-[11px] text-slate-500 font-medium">Ms. Chen • Apr 24, 3:00 PM</p>
                    </div>
                  </div>
                </div>
                
                <p className="text-sm text-slate-600 leading-relaxed pl-10">
                  The Spring Concert is next Thursday at 6:30 PM. Students should arrive by 6:00 PM in black and white attire.
                </p>
                
                <div className="pl-10 pt-2">
                  <div className="flex items-center gap-2 text-green-600 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4" />
                    Acknowledged by Maria Rivera · Apr 25, 8:12 AM
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Subtle Equity Footnote */}
            <div className="mt-8 text-center px-6">
              <p className="text-[10px] text-slate-400 leading-relaxed">
                Acknowledgement bonuses are optional small rewards for engagement. A student's recognition standing, core points, and support plans are never negatively affected by family acknowledgement status.
              </p>
            </div>

          </div>
        </main>
      </div>
    </div>
  );
}
