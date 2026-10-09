// a NULL write: with SHIRO_BLINK_CRASH=1 Blink reports where on stderr
int main(void) {
  *(volatile int *)8 = 1;
  return 0;
}
