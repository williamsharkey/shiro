# frozen_string_literal: true
# Shiro: io/console/size for the io/console stub
class IO
  def self.default_console_size = [ENV['LINES'].to_i.nonzero? || 25, ENV['COLUMNS'].to_i.nonzero? || 80]

  def self.console_size
    console&.winsize || default_console_size
  rescue SystemCallError
    default_console_size
  end
end
