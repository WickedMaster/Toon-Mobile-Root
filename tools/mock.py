import http.server, json, math, sys, os, urllib.parse, datetime, zoneinfo
WWW=sys.argv[1]; PORT=int(sys.argv[2])
CFGDIR=os.environ.get('TSC_CONFIG_DIR')
if CFGDIR:
    sys.path.insert(0,os.path.join(os.path.dirname(os.path.abspath(__file__)),'agent','test')); import toonconf
tz=zoneinfo.ZoneInfo("Europe/Amsterdam")
NOW=datetime.datetime(2026,10,8,14,20,tzinfo=tz).timestamp()
def mid(t): d=datetime.datetime.fromtimestamp(t,tz).replace(hour=0,minute=0,second=0,microsecond=0); return d.timestamp()
def hr(t): return (t-mid(t))/3600
def solar_w(t):
    h=hr(t); 
    if h<7.5 or h>18: return 0.0
    return max(0,2400*math.sin(math.pi*(h-7.5)/10.5)**1.5*(0.85+0.15*math.sin(h*7)))
def cons_w(t):
    h=hr(t); base=260+90*math.sin(h*1.3)
    if 7<=h<8.5: base+=700
    if 12<=h<13.5: base+=500
    if 17<=h<21: base+=900*math.sin(math.pi*(h-17)/4)
    return base+60*math.sin(t/300)
def gas_l(t):
    h=hr(t); return 0.05 if (6<h<22) else 0.0
def integ(f,t0,t1,step=300):
    s=0;t=t0
    while t<t1: s+=f(t)*step/3600; t+=step
    return s
BASE={'elec_quantity_nt':3412000,'elec_quantity_lt':2886000,'elec_solar_quantity':7120000,'gas_quantity':2145000}
T0=NOW-40*86400
def counter(name,t):
    if name=='elec_quantity_nt': f=lambda x:cons_w(x)*0.55
    elif name=='elec_quantity_lt': f=lambda x:cons_w(x)*0.45
    elif name=='elec_solar_quantity': f=solar_w
    else: f=lambda x:gas_l(x)*1000/ (1) *0.0  # unused
    if name=='gas_quantity':
        d=(t-T0)/86400; return BASE[name]+d*5200+ (hr(t)*220 if hr(t)>6 else 0)*0
    # approximate integral from T0 via daily repetition
    days=int((mid(t)-mid(T0))/86400)
    day_total=integ(f,mid(t)-86400,mid(t),900)
    return BASE[name]+days*day_total+integ(f,mid(t),t,900)
def series(name,rra,frm,to):
    out={}
    if name in('elec_flow','elec_solar_flow','gas_flow') :
        step=300; t=int(frm//step*step)
        while t<=min(to,NOW):
            v={'elec_flow':cons_w,'elec_solar_flow':solar_w,'gas_flow':lambda x:gas_l(x)*60}[name](t)
            out[str(t)]=round(v,1) if name!='gas_flow' else round(v,2); t+=step
        return out
    if rra=='5yrhours': step=3600
    else: step=86400
    t=int(math.ceil(frm/step)*step) if rra=='5yrhours' else int(mid(frm))+86400
    if rra!='5yrhours': t=int(mid(frm))
    last=None
    while t<=min(to,NOW):
        out[str(int(t))]=round(counter(name,t)); t+=step
    out[str(int(min(to,NOW)))]=round(counter(name,min(to,NOW)))
    return out
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a,directory=WWW,**k)
    def log_message(s,*a): pass
    def send_json(s,o):
        b=json.dumps(o).encode(); s.send_response(200); s.send_header('Content-Type','application/json'); s.send_header('Content-Length',str(len(b))); s.end_headers(); s.wfile.write(b)
    def do_GET(s):
        u=urllib.parse.urlparse(s.path); q=urllib.parse.parse_qs(u.query); a=(q.get('action') or [''])[0]
        p=u.path
        if p=='/happ_pwrusage':
            sw=solar_w(NOW); cw=cons_w(NOW)
            dayN=integ(lambda x:cons_w(x)*0.55,mid(NOW),NOW); dayL=integ(lambda x:cons_w(x)*0.45,mid(NOW),NOW)
            return s.send_json({'result':'ok','powerUsage':{'value':round(cw),'avgValue':410,'dayUsage':round(dayN),'dayLowUsage':round(dayL),'avgDayValue':9800,'valueSolar':round(sw),'solarProducedToday':round(integ(solar_w,mid(NOW),NOW))},'powerProduction':{'value':round(sw)},'gasUsage':{'dayUsage':3400,'avgDayValue':5200,'value':0}})
        if p=='/happ_thermstat':
            if a=='getThermostatInfo': return s.send_json({'result':'ok','currentTemp':2054,'currentSetpoint':2100,'activeState':1,'programState':1,'nextProgram':1,'nextState':2,'nextTime':int(mid(NOW)+22.5*3600),'nextSetpoint':1800,'randomConfigId':'x','errorFound':255,'boilerModuleConnected':1,'realSetpoint':2100})
            return s.send_json({'result':'ok'})
        if p=='/hcb_config' and CFGDIR and a=='setObjectConfig':
            cfg=(q.get('config') or [''])[0]
            for m in toonconf.blocks(cfg):
                if '<internalAddress>tscmailbox</internalAddress>' in m.group(1): toonconf.set_mailbox(CFGDIR,m.group(1))
            return s.send_json({'result':'ok'})
        if p=='/hcb_config' and CFGDIR and a=='getObjectConfigTree' and 'tscmailbox' in s.path:
            j=toonconf.mailbox_json(CFGDIR)
            return s.send_json(j if j else {'result':'error','error':'No such device'})
        if p=='/hcb_config' and CFGDIR and 'thermostatProgram' in s.path:
            return s.send_json(toonconf.get_program_json(CFGDIR))
        if p=='/hcb_config' and 'thermostatProgram' in s.path:
            b=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'prog.json'),'rb').read(); s.send_response(200); s.send_header('Content-Type','application/json'); s.send_header('Content-Length',str(len(b))); s.end_headers(); s.wfile.write(b); return
        if p=='/hcb_config':
            st=[{'id':0,'tempValue':2100,'dhw':1},{'id':1,'tempValue':1800,'dhw':1},{'id':2,'tempValue':1500,'dhw':1},{'id':3,'tempValue':1300,'dhw':1}]
            return s.send_json({'result':'ok','states':[{'state':st}]})
        if p=='/hcb_rrd':
            return s.send_json(series(q['loggerName'][0],q['rra'][0],float(q['from'][0]),float(q.get('to',[NOW])[0])))
        if p=='/hdrv_zwave':
            def pl(i,n,on,w): return {'uuid':'u%d'%i,'name':n,'type':'FGWPF102','IsConnected':'1','TargetStatus':'1' if on else '0','CurrentState':'1' if on else '0','CurrentElectricityFlow':str(w)}
            return s.send_json({'dev_settings_device':{},'d1':pl(1,'Wasmachine',1,412.3),'d2':pl(2,'Vaatwasser',0,0.0),'d3':pl(3,'TV-meubel',1,86.5),'d4':pl(4,'Kantoor',1,141.0),'d5':pl(5,'Waterkoker',0,0.0),**{'m%d'%i:{'uuid':'m%d'%i,'name':'HAE_METER_V3_%d'%i,'type':'HAE_METER_V3','IsConnected':'0','CurrentElectricityFlow':'0'} for i in range(1,7)}})
        return super().do_GET()
http.server.ThreadingHTTPServer(('127.0.0.1',PORT),H).serve_forever()
