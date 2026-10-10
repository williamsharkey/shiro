# frozen_string_literal: true
# Shiro: ruby.wasm lacks the io/console extension (WASI has no termios), so
# reline and irb couldn't load. The terminal stays in the tty's cooked mode:
# raw/noecho run their block as is, the size comes from COLUMNS/LINES.
class IO
  def winsize
    raise Errno::ENOTTY, inspect unless tty?
    rows = ENV['LINES'].to_i
    cols = ENV['COLUMNS'].to_i
    [rows > 0 ? rows : 24, cols > 0 ? cols : 80]
  end

  def winsize=(_size); end
  def raw(*, **) = yield(self)
  def raw!(*, **) = self
  def cooked(*) = yield(self)
  def cooked! = self
  def noecho(*) = yield(self)
  def echo=(_on); end
  def echo? = true
  def console_mode = nil
  def console_mode=(_mode); end
  def iflush = self
  def oflush = self
  def ioflush = self
  def beep = (write("\a"); self)
  def getch(*, **) = getc
  def getpass(prompt = nil)
    $stderr.print(prompt) if prompt
    line = gets
    $stderr.puts
    line&.chomp
  end

  def self.console(*)
    STDIN.tty? ? STDIN : nil
  end
end
