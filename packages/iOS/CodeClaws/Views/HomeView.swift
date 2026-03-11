import SwiftUI

struct HomeView: View {
    @State private var showCreate = false
    @State private var showSettings = false
    
    var body: some View {
        ProjectListView()
            .navigationTitle("CodeClaws")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    HStack {
                        Button(action: { showCreate = true }) {
                            Image(systemName: "plus")
                        }
                        Button(action: { showSettings = true }) {
                            Image(systemName: "gear")
                        }
                    }
                }
            }
            .navigationDestination(isPresented: $showCreate) {
                CreateProjectView()
            }
            .sheet(isPresented: $showSettings) {
                NavigationStack {
                    SettingsView()
                }
            }
    }
}
