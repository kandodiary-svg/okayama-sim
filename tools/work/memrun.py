import sys, subprocess, resource, time
t=time.time(); r=subprocess.call(sys.argv[1:])
print(f"MEMRUN exit={r} maxrss_MB={resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss/1024:.0f} sec={time.time()-t:.0f}", flush=True)
sys.exit(r)
