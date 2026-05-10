import React from "react";
import { 
  Heart, 
  Award, 
  Footprints, 
  Clock, 
  GraduationCap, 
  MessageCircle, 
  FileText,
  ChevronDown,
  TrendingUp,
  TrendingDown,
  Calendar,
  AlertCircle,
  CheckCircle2,
  Activity,
  User,
  Zap,
  Star
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const EkgDivider = () => (
  <div className="flex items-center justify-center my-8 opacity-20">
    <div className="h-px bg-red-500 w-full flex-1" />
    <svg width="120" height="24" viewBox="0 0 120 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-red-500 mx-4">
      <path d="M0 12H30L35 4L45 20L50 12H70L75 8L85 16L90 12H120" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
    <div className="h-px bg-red-500 w-full flex-1" />
  </div>
);

export function Snapshot() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans pb-24">
      {/* Brand Gradient Band */}
      <div className="h-1.5 w-full bg-gradient-to-r from-violet-600 via-teal-600 to-green-600" />

      <main className="max-w-6xl mx-auto px-6 pt-8 space-y-8">
        
        {/* 1. Identity Strip */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 bg-white p-6 rounded-3xl shadow-sm border border-slate-100">
          <div className="flex items-center gap-5">
            <Avatar className="h-20 w-20 border-4 border-slate-50 shadow-sm ring-1 ring-slate-100">
              <AvatarFallback className="bg-gradient-to-br from-violet-100 to-teal-100 text-violet-700 text-2xl font-bold">
                MR
              </AvatarFallback>
            </Avatar>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-2 hover:opacity-80 transition-opacity">
                      <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Maya Rodriguez</h1>
                      <ChevronDown className="h-5 w-5 text-slate-400" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuItem className="font-medium bg-slate-50">
                      Maya Rodriguez (8th)
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                      Diego Rodriguez (5th)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Badge variant="secondary" className="bg-green-100 text-green-700 hover:bg-green-100">
                  On track this week
                </Badge>
              </div>
              <p className="text-slate-500 font-medium">
                8th Grade · Homeroom: Ms. Chen, Rm 214
              </p>
            </div>
          </div>
          
          <div className="bg-slate-50 p-4 rounded-2xl flex items-center gap-4 min-w-[300px] border border-slate-100">
            <div className="h-10 w-10 rounded-full bg-violet-100 flex items-center justify-center shrink-0">
              <Clock className="h-5 w-5 text-violet-600" />
            </div>
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-0.5">Right Now</p>
              <p className="text-sm font-semibold text-slate-700">3rd Period · Algebra I</p>
              <p className="text-sm text-slate-500">Rm 318 (Mr. Davis)</p>
            </div>
          </div>
        </div>

        {/* 2. Pulse Cards */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card className="hover:shadow-md transition-shadow cursor-pointer border-slate-100 overflow-hidden group">
            <div className="h-1 w-full bg-gradient-to-r from-violet-500 to-green-500" />
            <CardContent className="p-5">
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-500">PBIS Points</p>
                <Award className="h-4 w-4 text-violet-500" />
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-slate-800">247</h3>
                <span className="text-xs font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full">+18 this wk</span>
              </div>
              <div className="mt-4 h-8 flex items-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                {[4, 6, 3, 7, 5, 8, 12].map((h, i) => (
                  <div key={i} className="w-full bg-violet-200 rounded-t-sm" style={{ height: `${h * 4}px` }} />
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow cursor-pointer border-slate-100 overflow-hidden group">
            <div className="h-1 w-full bg-teal-500" />
            <CardContent className="p-5">
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-500">Hall Passes</p>
                <Footprints className="h-4 w-4 text-teal-500" />
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-slate-800">4</h3>
                <span className="text-xs font-medium text-slate-500">/ limit 5</span>
              </div>
              <div className="mt-4 h-8 flex items-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                {[1, 0, 2, 0, 1].map((h, i) => (
                  <div key={i} className="w-full bg-teal-200 rounded-t-sm" style={{ height: `${(h/2) * 100}%` }} />
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow cursor-pointer border-slate-100 overflow-hidden group">
            <div className="h-1 w-full bg-amber-500" />
            <CardContent className="p-5">
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-500">Tardies</p>
                <Clock className="h-4 w-4 text-amber-500" />
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-slate-800">1</h3>
                <span className="text-xs font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">this week</span>
              </div>
              <div className="mt-4 h-8 flex items-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                {[0, 0, 1, 0, 0].map((h, i) => (
                  <div key={i} className="w-full bg-amber-200 rounded-t-sm" style={{ height: h ? '100%' : '10%' }} />
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow cursor-pointer border-slate-100 overflow-hidden group">
            <div className="h-1 w-full bg-blue-500" />
            <CardContent className="p-5">
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-500">Lost Minutes</p>
                <Activity className="h-4 w-4 text-blue-500" />
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-slate-800">22</h3>
                <span className="text-xs font-medium text-slate-500">min this wk</span>
              </div>
              <div className="mt-4 h-8 flex items-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                {[5, 0, 12, 0, 5].map((h, i) => (
                  <div key={i} className="w-full bg-blue-200 rounded-t-sm" style={{ height: `${(h/12) * 100}%` }} />
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow cursor-pointer border-slate-100 overflow-hidden group bg-slate-50/50">
            <div className="h-1 w-full bg-slate-300" />
            <CardContent className="p-5">
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-500">Days in ISS</p>
                <AlertCircle className="h-4 w-4 text-slate-400" />
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-slate-800">0</h3>
                <span className="text-xs font-medium text-slate-500">this year</span>
              </div>
              <div className="mt-4 h-8 flex items-center justify-center opacity-50">
                <div className="w-full h-px bg-slate-300" />
              </div>
            </CardContent>
          </Card>
        </div>

        <EkgDivider />

        {/* 3. Recognition & Rewards */}
        <Card className="border-slate-100 shadow-sm overflow-hidden">
          <div className="h-2 w-full bg-gradient-to-r from-violet-600 via-teal-500 to-green-500" />
          <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
            <div className="flex justify-between items-center">
              <CardTitle className="text-lg flex items-center gap-2">
                <Star className="h-5 w-5 text-violet-500 fill-violet-100" />
                Recognition & Rewards
              </CardTitle>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-sm font-medium text-slate-700">53 points to <span className="text-violet-700 font-bold">Bronze Star</span></p>
                </div>
                <div className="w-32">
                  <Progress value={82} className="h-2 bg-slate-200" />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
              <div className="p-6 space-y-4">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Recent Recognitions</h4>
                {[
                  { date: 'Apr 24', reason: 'Helped a classmate find lost binder', staff: 'Ms. Chen' },
                  { date: 'Apr 22', reason: 'Excellent participation', staff: 'Mr. Davis' },
                  { date: 'Apr 19', reason: 'Polite to substitute', staff: 'Mrs. Smith' },
                  { date: 'Apr 18', reason: 'Completed extra credit', staff: 'Mr. Park' },
                  { date: 'Apr 15', reason: 'Cleaned up lab station', staff: 'Ms. Johnson' },
                ].map((item, i) => (
                  <div key={i} className="flex gap-4 items-start">
                    <div className="w-12 shrink-0 text-xs font-medium text-slate-400 pt-0.5">{item.date}</div>
                    <div>
                      <p className="text-sm font-medium text-slate-800">{item.reason}</p>
                      <p className="text-xs text-slate-500">{item.staff}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-6 space-y-6 bg-slate-50/30">
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">What you've earned</h4>
                  <div className="space-y-3">
                    <div className="bg-white p-3 rounded-xl border border-slate-100 flex justify-between items-center shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-violet-100 flex items-center justify-center">
                          <Zap className="h-4 w-4 text-violet-600" />
                        </div>
                        <p className="text-sm font-medium">Snack Pass</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-bold text-violet-600">25 pts</p>
                        <p className="text-[10px] text-slate-400 uppercase tracking-wider">Apr 12</p>
                      </div>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-slate-100 flex justify-between items-center shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-teal-100 flex items-center justify-center">
                          <Footprints className="h-4 w-4 text-teal-600" />
                        </div>
                        <p className="text-sm font-medium">Front-of-Lunch-Line</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-bold text-teal-600">50 pts</p>
                        <p className="text-[10px] text-slate-400 uppercase tracking-wider">Mar 28</p>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Top Reasons Earned</h4>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-32 truncate text-slate-600">Preparedness</div>
                      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-violet-400 w-[80%]" />
                      </div>
                      <div className="w-6 text-right text-xs font-medium text-slate-500">24</div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-32 truncate text-slate-600">Helping Others</div>
                      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-violet-400/80 w-[60%]" />
                      </div>
                      <div className="w-6 text-right text-xs font-medium text-slate-500">18</div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-32 truncate text-slate-600">Participation</div>
                      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-violet-400/60 w-[45%]" />
                      </div>
                      <div className="w-6 text-right text-xs font-medium text-slate-500">14</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 4. This Week At a Glance */}
        <div className="bg-blue-900 text-white rounded-3xl p-6 shadow-md relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-teal-500/10 rounded-full blur-2xl -ml-10 -mb-10 pointer-events-none" />
          
          <div className="relative z-10 flex flex-col md:flex-row gap-8 items-center justify-between">
            <div className="w-full md:w-2/3 space-y-3">
              <h3 className="text-blue-100 text-sm font-semibold uppercase tracking-wider mb-1">Today's Schedule</h3>
              <div className="flex bg-blue-950/50 rounded-xl p-1.5 overflow-x-auto gap-1 hide-scrollbar">
                {[
                  { p: '1', name: 'Science', state: 'past' },
                  { p: '2', name: 'English', state: 'past' },
                  { p: '3', name: 'Algebra I', state: 'current' },
                  { p: 'L', name: 'Lunch', state: 'future' },
                  { p: '4', name: 'History', state: 'future' },
                  { p: '5', name: 'Art', state: 'future' },
                  { p: '6', name: 'PE', state: 'future' },
                ].map((period, i) => (
                  <div key={i} className={`flex-1 min-w-[80px] p-2 rounded-lg text-center flex flex-col justify-center transition-colors ${
                    period.state === 'current' ? 'bg-blue-500 shadow-sm ring-1 ring-blue-400' :
                    period.state === 'past' ? 'opacity-60' : 'bg-blue-800/40 hover:bg-blue-800/60'
                  }`}>
                    <p className="text-[10px] font-bold text-blue-200/80 mb-0.5">P{period.p}</p>
                    <p className={`text-xs font-medium truncate ${period.state === 'current' ? 'text-white' : 'text-blue-100'}`}>
                      {period.name}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="w-full md:w-1/3 flex justify-between divide-x divide-blue-800/50">
              <div className="px-4 text-center flex-1">
                <p className="text-[10px] text-blue-300 font-semibold uppercase tracking-wider mb-1">Recogs</p>
                <p className="text-2xl font-bold text-white">4</p>
              </div>
              <div className="px-4 text-center flex-1">
                <p className="text-[10px] text-blue-300 font-semibold uppercase tracking-wider mb-1">Tardies</p>
                <p className="text-2xl font-bold text-amber-300">1</p>
              </div>
              <div className="px-4 text-center flex-1">
                <p className="text-[10px] text-blue-300 font-semibold uppercase tracking-wider mb-1">Passes</p>
                <p className="text-2xl font-bold text-teal-300">4</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* 5. Attendance & Movement */}
          <div className="space-y-4">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Footprints className="h-5 w-5 text-teal-600" />
              Attendance & Movement
            </h3>
            
            <Card className="border-slate-100 shadow-sm">
              <CardContent className="p-0">
                <div className="bg-amber-50 border-b border-amber-100 p-4">
                  <div className="flex gap-3 items-start">
                    <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-amber-900">Pattern Noticed</p>
                      <p className="text-sm text-amber-700">Heads up: 2 of 3 tardies this month are 1st period.</p>
                    </div>
                  </div>
                </div>
                
                <div className="p-5 space-y-6">
                  <div>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Tardies (Last 3)</h4>
                    <div className="space-y-2">
                      {[
                        { date: 'Apr 24', period: 'P1', reason: 'Unexcused' },
                        { date: 'Apr 12', period: 'P1', reason: 'Late bus' },
                        { date: 'Mar 28', period: 'P4', reason: 'Unexcused' }
                      ].map((t, i) => (
                        <div key={i} className="flex justify-between items-center text-sm p-2 rounded-lg bg-slate-50">
                          <span className="font-medium text-slate-700 w-20">{t.date}</span>
                          <span className="text-slate-500 w-12">{t.period}</span>
                          <span className="text-slate-600 flex-1 text-right">{t.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  <div>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Hall Passes (This Week)</h4>
                    <div className="space-y-2">
                      {[
                        { date: 'Apr 25', time: '10:14 AM', dest: 'Restroom', dur: '4m' },
                        { date: 'Apr 24', time: '1:45 PM', dest: 'Nurse', dur: '12m' },
                        { date: 'Apr 22', time: '9:30 AM', dest: 'Office', dur: '8m' },
                        { date: 'Apr 22', time: '8:15 AM', dest: 'Locker', dur: '6m', flag: 'Tardy Return' },
                      ].map((p, i) => (
                        <div key={i} className="flex items-center text-sm p-2.5 rounded-lg border border-slate-100 shadow-sm">
                          <div className="w-16 font-medium text-slate-700 text-xs">{p.date}</div>
                          <div className="w-20 text-slate-500 text-xs">{p.time}</div>
                          <div className="flex-1 font-medium text-slate-800">{p.dest}</div>
                          <div className="flex items-center gap-2">
                            <span className="text-slate-500 text-xs">{p.dur}</span>
                            {p.flag && <Badge variant="destructive" className="text-[10px] px-1.5 h-4 font-semibold leading-none py-0">Flag</Badge>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* 6. Support Provided */}
          <div className="space-y-4">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Heart className="h-5 w-5 text-green-600" />
              Support Provided
            </h3>
            
            <Card className="border-slate-100 shadow-sm h-[calc(100%-2.25rem)]">
              <CardContent className="p-0 flex flex-col h-full">
                <div className="p-5 border-b border-slate-100 space-y-3 bg-green-50/50">
                  <div className="flex justify-between items-start">
                    <div>
                      <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200 mb-2">Active MTSS Plan: Tier 2</Badge>
                      <p className="text-sm font-medium text-slate-800">Goal: Improve 1st-period punctuality</p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-slate-500 font-medium">
                      <span>Progress</span>
                      <span className="text-green-700">65%</span>
                    </div>
                    <Progress value={65} className="h-2 bg-green-100" />
                  </div>
                </div>
                
                <div className="p-5 space-y-6 flex-1">
                  <div>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Trusted Adult Check-ins</h4>
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="bg-slate-200 text-slate-600 text-xs">CW</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="text-sm font-medium text-slate-800">Coach Williams</p>
                        <p className="text-xs text-slate-500">3 check-ins this month</p>
                      </div>
                    </div>
                  </div>
                  
                  <div>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Pullouts</h4>
                    <div className="space-y-2">
                      {[
                        { date: 'Apr 20', type: 'Academic', status: 'Returned', statusColor: 'bg-slate-100 text-slate-600' },
                        { date: 'Apr 14', type: 'Behavior', status: 'Returned', statusColor: 'bg-slate-100 text-slate-600' },
                        { date: 'Apr 02', type: 'Counselor', status: 'Returned', statusColor: 'bg-slate-100 text-slate-600' }
                      ].map((p, i) => (
                        <div key={i} className="flex justify-between items-center text-sm p-2 rounded-lg bg-slate-50">
                          <span className="font-medium text-slate-700 w-16">{p.date}</span>
                          <span className="text-slate-600 flex-1">{p.type}</span>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${p.statusColor}`}>{p.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <EkgDivider />

        {/* 7. Accommodations on File */}
        <div className="space-y-4">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <FileText className="h-5 w-5 text-rose-500" />
            Accommodations on File
          </h3>
          <Card className="border-slate-100 shadow-sm">
            <CardContent className="p-5 space-y-6">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-sm py-1">Extended time on tests</Badge>
                <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-sm py-1">Preferential seating</Badge>
                <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-sm py-1">Frequent breaks</Badge>
              </div>
              
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Recent Logs</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-slate-500 bg-slate-50 uppercase font-semibold">
                      <tr>
                        <th className="px-4 py-2 rounded-l-lg">Period / Staff</th>
                        <th className="px-4 py-2">Accommodation</th>
                        <th className="px-4 py-2 rounded-r-lg text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {[
                        { context: 'P1 · Mr. Park', acc: 'Preferential seating', status: 'Provided', ok: true },
                        { context: 'P3 · Mr. Davis', acc: 'Extended time', status: 'Provided', ok: true },
                        { context: 'P4 · Mrs. Smith', acc: 'Frequent breaks', status: 'Not provided', ok: false },
                      ].map((log, i) => (
                        <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">{log.context}</td>
                          <td className="px-4 py-3 text-slate-600">{log.acc}</td>
                          <td className="px-4 py-3 text-right">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                              log.ok ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
                            }`}>
                              {log.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 8. Academic Progress */}
        <div className="space-y-4">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <GraduationCap className="h-5 w-5 text-blue-600" />
            Academic Progress
            <Badge variant="outline" className="ml-2 bg-slate-100 text-slate-500 border-slate-200 text-xs">FAST PM Scores</Badge>
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="border-slate-100 shadow-sm bg-gradient-to-br from-white to-blue-50/30">
              <CardContent className="p-5">
                <div className="flex justify-between items-center mb-6">
                  <h4 className="font-bold text-slate-800 text-lg">ELA Reading</h4>
                  <p className="text-xs text-slate-500 font-medium">Prior year: 471</p>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <div className="flex-1 bg-slate-50 rounded-2xl p-3 text-center border border-slate-100 relative">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">PM 1</p>
                    <p className="text-2xl font-bold text-slate-700">478</p>
                  </div>
                  <TrendingUp className="h-5 w-5 text-slate-300 shrink-0" />
                  <div className="flex-1 bg-blue-50/50 rounded-2xl p-3 text-center border border-blue-100 relative">
                    <p className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-1">PM 2</p>
                    <p className="text-2xl font-bold text-blue-700">491</p>
                  </div>
                  <TrendingUp className="h-5 w-5 text-green-300 shrink-0" />
                  <div className="flex-1 bg-green-50 rounded-2xl p-3 text-center border border-green-200 relative shadow-sm ring-1 ring-green-100">
                    <p className="text-[10px] font-bold text-green-500 uppercase tracking-widest mb-1">PM 3</p>
                    <p className="text-2xl font-bold text-green-700">502</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-100 shadow-sm bg-gradient-to-br from-white to-blue-50/30">
              <CardContent className="p-5">
                <div className="flex justify-between items-center mb-6">
                  <div className="flex items-center gap-2">
                    <h4 className="font-bold text-slate-800 text-lg">Mathematics</h4>
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px] px-1.5 py-0">BQ Flag</Badge>
                  </div>
                  <p className="text-xs text-slate-500 font-medium">Prior year: 471</p>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <div className="flex-1 bg-slate-50 rounded-2xl p-3 text-center border border-slate-100 relative">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">PM 1</p>
                    <p className="text-2xl font-bold text-slate-700">462</p>
                  </div>
                  <TrendingDown className="h-5 w-5 text-amber-300 shrink-0" />
                  <div className="flex-1 bg-amber-50/50 rounded-2xl p-3 text-center border border-amber-100 relative">
                    <p className="text-[10px] font-bold text-amber-400 uppercase tracking-widest mb-1">PM 2</p>
                    <p className="text-2xl font-bold text-amber-700">458</p>
                  </div>
                  <TrendingUp className="h-5 w-5 text-blue-300 shrink-0" />
                  <div className="flex-1 bg-blue-50 rounded-2xl p-3 text-center border border-blue-200 relative shadow-sm">
                    <p className="text-[10px] font-bold text-blue-500 uppercase tracking-widest mb-1">PM 3</p>
                    <p className="text-2xl font-bold text-blue-700">470</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* 9 & 10. Notes & Comm History */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4">
          <div className="space-y-4">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-amber-500" />
              Notes from Staff
            </h3>
            <div className="space-y-3">
              {[
                { date: 'Apr 18', staff: 'Mr. Park', note: "Maya stayed after class to ask great questions about polynomials. Great initiative today!" },
                { date: 'Apr 05', staff: 'Ms. Chen', note: "Very helpful during homeroom organizing the lab supplies." }
              ].map((note, i) => (
                <div key={i} className="bg-amber-50/50 p-4 rounded-2xl border border-amber-100 relative shadow-sm">
                  <div className="absolute top-4 right-4 text-amber-200">
                    <MessageCircle className="h-6 w-6 opacity-50" fill="currentColor" />
                  </div>
                  <p className="text-sm text-slate-700 leading-relaxed mb-3 relative z-10 pr-8">"{note.note}"</p>
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-bold text-amber-700">— {note.staff}</span>
                    <span className="text-slate-400 font-medium">{note.date}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <User className="h-5 w-5 text-slate-500" />
              Communication History
            </h3>
            <Card className="border-slate-100 shadow-sm">
              <CardContent className="p-0">
                <div className="divide-y divide-slate-50">
                  {[
                    { date: 'Apr 24', subj: '🎉 Maya hit 200 PBIS points!', type: 'Milestone' },
                    { date: 'Apr 19', subj: 'Weekly HeartBEAT Update', type: 'HeartBEAT' },
                    { date: 'Apr 02', subj: 'Pullout to counselor — completed', type: 'Pullout' },
                    { date: 'Mar 28', subj: 'Upcoming Field Trip info', type: 'Family Comm' },
                  ].map((comm, i) => (
                    <div key={i} className="p-3.5 flex items-center justify-between hover:bg-slate-50 transition-colors">
                      <div className="flex-1 min-w-0 pr-4">
                        <p className="text-sm font-medium text-slate-800 truncate mb-1">{comm.subj}</p>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400">{comm.date}</span>
                          <span className="text-slate-300">•</span>
                          <span className="text-slate-500">{comm.type}</span>
                        </div>
                      </div>
                      <div className="shrink-0">
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* 11. Footer CTA */}
        <div className="pt-12 pb-8 flex flex-col items-center text-center space-y-4">
          <Button size="lg" className="bg-gradient-to-r from-violet-600 via-teal-600 to-green-600 hover:opacity-90 transition-opacity text-white rounded-xl h-14 px-8 text-lg font-bold shadow-lg shadow-teal-500/20 border-0">
            Generate HeartBEAT Report
          </Button>
          <button className="text-sm text-slate-500 hover:text-slate-800 font-medium transition-colors">
            Customize what's included &rarr;
          </button>
        </div>

      </main>
    </div>
  );
}
