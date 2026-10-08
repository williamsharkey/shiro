/* Benchmark: same loop as cpuloop.go in C. musl-gcc -static -O2 -o cloop cloop.c */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(int argc,char**argv){ long n=argc>1?atol(argv[1]):5000000; struct timespec a,b; clock_gettime(CLOCK_MONOTONIC,&a);
unsigned long x=1; for(long i=0;i<n;i++){ x=x*6364136223846793005UL+1442695040888963407UL; x^=x>>13; }
clock_gettime(CLOCK_MONOTONIC,&b); printf("cloop %ld x=%lu %ldms\n",n,x,(b.tv_sec-a.tv_sec)*1000+(b.tv_nsec-a.tv_nsec)/1000000); return 0; }
